/**
 * Host-side capability bridge for the `run_code` sandbox (§6.4).
 *
 * The bridge is the isolate's ONLY egress. It exposes exactly one host function
 * to the isolate — `__capCall(id, argsJson)` — and a preamble that builds a
 * FROZEN in-isolate `caps.<service>.<tool>(args)` accessor over it. Every call
 * routes host-side through the real P0 {@link executeTool}: input validation,
 * secret resolution (host-side, never in the isolate), handler, output
 * validation. Args cross OUT as a JSON string; results cross BACK as a JSON
 * string. No host object/Reference is ever stored in the isolate (escape
 * defense T1).
 *
 * Errors do NOT cross as native rejections (which would lose the P0 code).
 * Instead `__capCall` always RESOLVES with a tagged JSON envelope:
 *   { ok: true, value }                 — success
 *   { ok: false, code, message }        — a GatewayError (P0 code preserved)
 * The in-isolate accessor re-throws a marked Error the host can map back to a
 * coded {@link GatewayError} (see {@link CAP_ERROR_PREFIX}).
 */
import type { CatalogEntry } from "../catalog/types.js";
import type { SecretProvider } from "../secrets/provider.js";
import { executeTool } from "../execute/runner.js";
import { GatewayError } from "../errors/to-tool-error.js";

/** Marker a re-thrown capability error carries so the host can reconstruct the code. */
export const CAP_ERROR_PREFIX = "__CAP_ERR__";

/** Tagged envelope the host returns for every capability call. */
type CapEnvelope =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string };

/**
 * Build the host function the isolate invokes via `applySyncPromise`.
 *
 * It NEVER throws — it resolves with a {@link CapEnvelope} so a capability
 * failure crosses the boundary as data (with its P0 code intact) rather than as
 * a native rejection that would erase the code.
 */
export function makeHostCall(deps: {
  index: CatalogEntry[];
  secrets: SecretProvider;
}): (id: string, argsJson: string) => Promise<string> {
  return async (id, argsJson) => {
    let envelope: CapEnvelope;
    try {
      const args: unknown = argsJson === "" ? {} : JSON.parse(argsJson);
      // Reuse the P0 execute path VERBATIM: validation + secrets + handler +
      // output validation all happen host-side. Secrets never enter the isolate.
      const value = await executeTool(id, args, { index: deps.index, secrets: deps.secrets });
      envelope = { ok: true, value };
    } catch (e) {
      if (e instanceof GatewayError) {
        envelope = { ok: false, code: e.code, message: e.message };
      } else {
        envelope = { ok: false, code: "internal_error", message: (e as Error).message };
      }
    }
    return JSON.stringify(envelope);
  };
}

/**
 * The in-isolate preamble. Builds a frozen `caps` object whose every
 * `caps[service][tool]` calls the host `__capCall` synchronously (via
 * `applySyncPromise`, which blocks the isolate until the host Promise settles —
 * so model code calls capabilities with NO `await`). `__capCall` and the host
 * reference are deleted from the global after `caps` is built so model code
 * cannot reach the raw Reference (escape-surface reduction).
 *
 * @param toolIds - the `service.tool` ids the bridge exposes.
 */
export function buildPreamble(toolIds: string[]): string {
  // Group ids by service so we can build caps[service][tool].
  const byService: Record<string, string[]> = {};
  for (const id of toolIds) {
    const dot = id.indexOf(".");
    if (dot <= 0) continue; // skip malformed ids (defensive; ids are "service.tool")
    const service = id.slice(0, dot);
    const tool = id.slice(dot + 1);
    (byService[service] ??= []).push(tool);
  }

  // A JSON blob the preamble reads to build the accessors — keeps the generated
  // code injection-free (no id is interpolated into executable positions).
  const map = JSON.stringify(byService);

  return `
"use strict";
(function () {
  const __byService = ${map};
  // Capture the host Reference into a closure local, then remove it from the
  // global so model code can never reach the raw Reference (escape defense T1).
  const __ref = __capCall;
  const __call = function (id, args) {
    const env = JSON.parse(__ref.applySyncPromise(undefined, [id, JSON.stringify(args === undefined ? {} : args)]));
    if (!env.ok) {
      throw new Error(${JSON.stringify(CAP_ERROR_PREFIX)} + JSON.stringify({ code: env.code, message: env.message }));
    }
    return env.value;
  };
  const caps = {};
  for (const service of Object.keys(__byService)) {
    const svc = {};
    for (const tool of __byService[service]) {
      const id = service + "." + tool;
      svc[tool] = Object.freeze(function (args) { return __call(id, args); });
    }
    caps[service] = Object.freeze(svc);
  }
  globalThis.caps = Object.freeze(caps);
  // Remove the raw host reference from the global so model code can't reach it.
  delete globalThis.__capCall;
})();
`;
}

/**
 * If `e` is a re-thrown in-isolate capability error, reconstruct the original
 * coded {@link GatewayError}; otherwise return `undefined`.
 */
export function decodeCapError(message: string): GatewayError | undefined {
  if (!message.startsWith(CAP_ERROR_PREFIX)) return undefined;
  try {
    const { code, message: msg } = JSON.parse(message.slice(CAP_ERROR_PREFIX.length)) as {
      code: string;
      message: string;
    };
    return new GatewayError(code as GatewayError["code"], msg);
  } catch {
    return undefined;
  }
}
