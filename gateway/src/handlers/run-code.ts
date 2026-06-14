/**
 * `run_code` handler: run a model-written JS program in the V8 sandbox.
 *
 * Validates `{ source }` (empty/whitespace → `invalid_args`, the same P0 code as
 * a bad `execute` arg) and delegates to the injected sandbox runner. The sandbox
 * throws coded {@link GatewayError}s (`sandbox_timeout` / `sandbox_memory` /
 * `sandbox_error`, or a P0 code from a capability call); `server.ts` funnels them
 * through `toToolError`. The handler never reaches the isolate or secrets
 * directly — it only forwards source to the runner.
 */
import { z } from "zod";
import { invalidArgs } from "../errors/to-tool-error.js";

const InputSchema = z.object({ source: z.string() });

export interface RunCodeInput {
  source: string;
}

/** The sandbox capability the handler needs, injected for testability. */
export interface RunCodeDeps {
  /** Run model source in a fresh isolate; returns ONLY the program's value. */
  sandbox: { run(source: string): Promise<unknown> };
}

export async function runCode(input: RunCodeInput, deps: RunCodeDeps): Promise<unknown> {
  let parsed: RunCodeInput;
  try {
    parsed = InputSchema.parse(input);
  } catch {
    throw invalidArgs("source must be a string");
  }
  if (parsed.source.trim() === "") {
    throw invalidArgs("source must not be empty");
  }
  return deps.sandbox.run(parsed.source);
}
