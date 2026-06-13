/**
 * The V8 sandbox behind `run_code` (WS-1, design D2/D6).
 *
 * Owns the isolate lifecycle: a FRESH isolate per `run` call, with a memory cap
 * and a wall-clock timeout, disposed in `finally`. Model source runs with NO
 * Node APIs, NO network, NO fs — the only egress is the capability bridge
 * (Group B), which calls P0 `executeTool` host-side and marshals validated
 * results back. Only the program's return value leaves the isolate.
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

/**
 * Wrap model source so its value is the program result. The source is run as the
 * body of an IIFE: a bare expression (`1 + 1`) or an explicit `return` both work,
 * and statements are allowed. The result is JSON-marshaled out of the isolate.
 */
function wrap(source: string): string {
  return `JSON.stringify((function(){ return ( ${source} \n); })())`;
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
   */
  async run(source: string): Promise<unknown> {
    assertNodeSnapshotDisabled();
    const ivm = await this.#load();

    const isolate = new ivm.Isolate({ memoryLimit: this.#limits.memoryLimitMb });
    try {
      const context = isolate.createContextSync();
      const script = isolate.compileScriptSync(wrap(source));
      const json = (await script.run(context, {
        timeout: this.#limits.timeoutMs,
        copy: true,
      })) as string | undefined;
      return json === undefined ? undefined : JSON.parse(json);
    } finally {
      isolate.dispose();
    }
  }
}
