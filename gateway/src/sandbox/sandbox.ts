/**
 * The V8 sandbox behind `run_code` (WS-1, design D2/D6).
 *
 * Owns the isolate lifecycle: a FRESH isolate per `run` call, with a memory cap
 * and a wall-clock timeout, disposed in `finally`. Model source runs with NO
 * Node APIs, NO network, NO fs — the only egress is the capability bridge
 * ({@link buildPreamble}/{@link makeHostCall}), which calls P0 `executeTool`
 * host-side and marshals validated results back. Only the program's return
 * value leaves the isolate.
 *
 * `isolated-vm` is a native module and is **lazy-imported** on first `run` so
 * that importing the gateway (or running non-sandbox tests) never requires the
 * native build at module-eval time. Only the TYPE is imported statically (types
 * are erased at compile time).
 */
import type IVM from "isolated-vm";
import type { CatalogEntry } from "../catalog/types.js";
import type { SecretProvider } from "../secrets/provider.js";
import { assertNodeSnapshotDisabled } from "./node-flags.js";
import { makeHostCall, buildPreamble, decodeCapError } from "./bridge.js";
import { desugarCapsImports } from "./import-sugar.js";
import { GatewayError, sandboxError, sandboxTimeout, sandboxMemory, configInvalid } from "../errors/to-tool-error.js";

/** Resource caps for an isolate run. Conservative defaults per §6.2(d). */
export interface SandboxLimits {
  memoryLimitMb: number;
  timeoutMs: number;
}

export const DEFAULT_LIMITS: SandboxLimits = { memoryLimitMb: 128, timeoutMs: 5000 };

/** Everything the sandbox needs; the bridge is built from index + secrets host-side. */
export interface SandboxDeps {
  index: CatalogEntry[];
  secrets: SecretProvider;
  limits?: Partial<SandboxLimits>;
}

/** Marker the in-isolate wrapper throws for a non-serializable return type. */
const NONCLONABLE_PREFIX = "__NONCLONABLE__";

/**
 * The marshal tail: given a computed `__ret`, reject non-serializable types and
 * JSON-marshal the value in a `{ v: ... }` envelope (so the host can tell a
 * legitimate `undefined` return apart from a dropped value).
 */
const MARSHAL_TAIL = `
const __t = typeof __ret;
if (__t === "function" || __t === "symbol") {
  throw new Error(${JSON.stringify(NONCLONABLE_PREFIX)} + ":" + __t);
}
JSON.stringify({ v: __ret });
`;

/**
 * Expression form: the whole source is one expression whose value is the result
 * (`1 + 1`, `caps.echo.echo({...})`, `(() => {...})()`).
 */
function wrapExpression(source: string): string {
  return `const __ret = ( ${source} \n);\n${MARSHAL_TAIL}`;
}

/**
 * Body form: the source is a function body using `return` to produce a value,
 * or statements with no value (`while (true) {}` → `undefined`). Used when the
 * expression form fails to compile.
 */
function wrapBody(source: string): string {
  return `const __ret = (function () { ${source} \n })();\n${MARSHAL_TAIL}`;
}

export class Sandbox {
  readonly #deps: SandboxDeps;
  readonly #limits: SandboxLimits;
  #ivm: typeof IVM | undefined;

  constructor(deps: SandboxDeps) {
    this.#deps = deps;
    this.#limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  /**
   * Lazily load the native module on first use.
   *
   * `isolated-vm` is an OPTIONAL dependency (O9): an install whose native build
   * was skipped/failed still yields a working 4-tool gateway. When the module is
   * genuinely absent, the dynamic import throws `ERR_MODULE_NOT_FOUND` — we map
   * that to a clean `config_invalid` (the same coded-error channel as the
   * snapshot guard) so `run_code` fails informatively instead of surfacing an
   * opaque `internal_error`. search/get_schema/resolve_skill/execute never reach
   * here, so they keep working with no native module present.
   */
  async #load(): Promise<typeof IVM> {
    if (!this.#ivm) {
      try {
        this.#ivm = (await import("isolated-vm")).default;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
          throw configInvalid(
            'the optional native dependency "isolated-vm" is not installed, so run_code is ' +
              "unavailable. The other tools (search_capabilities, get_schema, resolve_skill, " +
              'execute) work without it. To enable run_code, install "isolated-vm" (a prebuilt ' +
              "binary, or a node-gyp build needing Python + a C/C++ toolchain).",
          );
        }
        throw e;
      }
    }
    return this.#ivm;
  }

  /**
   * Run model `source` in a fresh isolate; return ONLY the program's return
   * value (deep-copied out via JSON marshal).
   *
   * @throws {@link GatewayError} — `sandbox_timeout`, `sandbox_memory`,
   *   `sandbox_error`, or a P0 code (e.g. `unknown_id`, `invalid_args`) from a
   *   capability call inside the program.
   */
  async run(source: string): Promise<unknown> {
    assertNodeSnapshotDisabled();
    const ivm = await this.#load();

    const isolate = new ivm.Isolate({ memoryLimit: this.#limits.memoryLimitMb });
    try {
      const context = isolate.createContextSync();

      // Install the single host egress function. Marked `ignored: false` is the
      // default; the isolate reaches it via applySyncPromise from the preamble.
      const hostCall = makeHostCall({ index: this.#deps.index, secrets: this.#deps.secrets });
      context.global.setSync("__capCall", new ivm.Reference(hostCall));

      const toolIds = this.#deps.index.filter((e) => e.kind === "tool").map((e) => e.id);
      const preamble = buildPreamble(toolIds) + "\n";

      // Rewrite `import { x } from "caps/<svc>"` sugar to `const { x } = caps.<svc>;`
      // over the frozen global BEFORE compiling (the bare isolate has no module
      // loader). A malformed/dangerous binding throws here → mapped to
      // sandbox_error by the catch (injection-free codegen, plan §8.3). Desugared
      // output is statements, so #compile's expression form fails and it falls
      // back to the function-body form automatically.
      const desugared = desugarCapsImports(source);

      // Compile the source as an expression; if that's a syntax error (e.g. the
      // program is statements like `while (true) {}` or uses `return`), fall back
      // to the function-body form. Both compile attempts stay inside the catch so
      // a genuine syntax error still surfaces as a coded sandbox_error.
      const script = this.#compile(isolate, preamble, desugared);

      const json = (await script.run(context, {
        timeout: this.#limits.timeoutMs,
        copy: true,
      })) as string | undefined;

      if (json === undefined) return undefined;
      const parsed = JSON.parse(json) as { v?: unknown };
      return parsed.v;
    } catch (e) {
      throw this.#mapError(e);
    } finally {
      // dispose() throws if the isolate already self-disposed (e.g. on OOM).
      // Guard it so a finally-throw never masks the real error.
      if (!isolate.isDisposed) {
        try {
          isolate.dispose();
        } catch {
          // already gone; nothing to do
        }
      }
    }
  }

  /** Compile expression-form first; fall back to body-form on a syntax error. */
  #compile(isolate: IVM.Isolate, preamble: string, source: string): IVM.Script {
    try {
      return isolate.compileScriptSync(preamble + wrapExpression(source));
    } catch {
      return isolate.compileScriptSync(preamble + wrapBody(source));
    }
  }

  /** Map an isolate-side failure to a coded {@link GatewayError}. */
  #mapError(e: unknown): GatewayError {
    if (e instanceof GatewayError) return e;
    const message = e instanceof Error ? e.message : String(e);

    // A capability call inside the isolate that failed carries its P0 code.
    const capErr = decodeCapError(stripIsolatePrefix(message));
    if (capErr) return capErr;

    // isolated-vm's timeout message (§11.5: "Script execution timed out.").
    if (/timed out/i.test(message)) return sandboxTimeout(this.#limits.timeoutMs);

    // V8 OOM inside the isolate (memoryLimit hit). isolated-vm force-disposes the
    // isolate and rejects with "Isolate was disposed during execution due to
    // memory limit" (verified against isolated-vm@6.0.2).
    if (/disposed during execution due to memory limit|out of memory|reached heap limit/i.test(message)) {
      return sandboxMemory(this.#limits.memoryLimitMb);
    }

    if (message.startsWith(NONCLONABLE_PREFIX)) {
      return sandboxError("the program returned a non-serializable value");
    }

    // Anything else: model code threw, failed to compile, or returned a value
    // the marshaler rejected. Message is sanitized (isolate-side only, no host
    // stack) by construction.
    return sandboxError(message);
  }
}

/**
 * Strip isolated-vm's stack-frame prefix so {@link decodeCapError} sees the bare
 * thrown message. isolated-vm sometimes prefixes the message line; the marker is
 * always present in the message body.
 */
function stripIsolatePrefix(message: string): string {
  const idx = message.indexOf("__CAP_ERR__");
  return idx >= 0 ? message.slice(idx) : message;
}
