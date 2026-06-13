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
import { GatewayError, sandboxError, sandboxTimeout, sandboxMemory } from "../errors/to-tool-error.js";

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
 * Wrap model source so its value is marshaled out as a JSON string. A bare
 * expression or an explicit `return` both work. Functions/symbols (and circular
 * objects, which make `JSON.stringify` throw) are rejected here so a
 * non-clonable return surfaces as `sandbox_error` rather than silently becoming
 * `undefined`. The `{ v: ... }` envelope lets the host tell a legitimate
 * `undefined` return apart from a dropped value.
 */
function wrap(source: string): string {
  return `
const __ret = (function () { return ( ${source} \n); })();
const __t = typeof __ret;
if (__t === "function" || __t === "symbol") {
  throw new Error(${JSON.stringify(NONCLONABLE_PREFIX)} + ":" + __t);
}
JSON.stringify({ v: __ret });
`;
}

export class Sandbox {
  readonly #deps: SandboxDeps;
  readonly #limits: SandboxLimits;
  #ivm: typeof IVM | undefined;

  constructor(deps: SandboxDeps) {
    this.#deps = deps;
    this.#limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  /** Lazily load the native module on first use. */
  async #load(): Promise<typeof IVM> {
    if (!this.#ivm) {
      this.#ivm = (await import("isolated-vm")).default;
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
      const program = buildPreamble(toolIds) + "\n" + wrap(source);

      const script = isolate.compileScriptSync(program);
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
      isolate.dispose();
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

    // V8 OOM inside the isolate (memoryLimit hit) surfaces as a RangeError about
    // heap; isolated-vm also reports the isolate as disposed.
    if (/out of memory|heap (out of memory|limit)|array buffer allocation failed/i.test(message)) {
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
