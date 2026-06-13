/**
 * Guard: `isolated-vm` requires the Node process to be launched with
 * `--no-node-snapshot` (Node >= 20) for a V8 isolate to initialize. If it is
 * absent, isolate creation fails with a cryptic native error. We instead fail
 * loud with a coded {@link configInvalid} carrying the exact remediation, so an
 * operator sees a clear message rather than a crash.
 *
 * The check is a pure function over the two ways the flag is observable at
 * runtime, so it is testable without re-launching node:
 *   - `process.execArgv` — when passed directly (`node --no-node-snapshot ...`)
 *   - `process.env.NODE_OPTIONS` — when set via the environment
 */
import { configInvalid } from "../errors/to-tool-error.js";

const FLAG = "--no-node-snapshot";

/** The runtime signals the guard inspects (injected for testability). */
export interface NodeFlagState {
  execArgv: readonly string[];
  nodeOptions: string | undefined;
}

/** True when `--no-node-snapshot` is active via execArgv or NODE_OPTIONS. */
export function isNodeSnapshotDisabled(state: NodeFlagState): boolean {
  if (state.execArgv.includes(FLAG)) return true;
  if (state.nodeOptions?.split(/\s+/).includes(FLAG)) return true;
  return false;
}

/**
 * Throw {@link configInvalid} with remediation if `--no-node-snapshot` is not
 * active. Defaults to reading the live process state.
 */
export function assertNodeSnapshotDisabled(
  state: NodeFlagState = { execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS },
): void {
  if (isNodeSnapshotDisabled(state)) return;
  throw configInvalid(
    `run_code requires the gateway to be launched with "${FLAG}" (Node >= 20) so the ` +
      `isolated-vm sandbox can initialize. Re-launch node with "${FLAG}" ` +
      `(e.g. NODE_OPTIONS="${FLAG}" or add it to the node invocation).`,
  );
}
