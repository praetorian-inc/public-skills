/**
 * `execute` handler: run a tool by id with the given args.
 *
 * If `id` is a skill → `kind_mismatch`; otherwise delegate to the runner, which
 * loads the wrapper, validates input, injects secrets, runs the handler, and
 * validates output. All failures are coded {@link GatewayError}s; `server.ts`
 * funnels them through `toToolError`.
 */
import type { CatalogEntry } from "../catalog/types.js";
import type { SecretProvider } from "../secrets/provider.js";
import { executeTool } from "../execute/runner.js";

export interface ExecuteInput {
  id: string;
  args: unknown;
}

export interface ExecuteDeps {
  index: CatalogEntry[];
  secrets: SecretProvider;
}

export async function execute(input: ExecuteInput, deps: ExecuteDeps): Promise<unknown> {
  return executeTool(input.id, input.args, { index: deps.index, secrets: deps.secrets });
}
