/**
 * Build the MCP server exposing EXACTLY the 4 capability-gateway meta-tools:
 * `search_capabilities`, `get_schema`, `resolve_skill`, `execute`.
 *
 * Each tool's body runs through {@link toToolError} so the MCP layer never sees
 * a raw throw — every failure becomes a structured `{isError, content}` result
 * with a stable `code`. Successful results are returned as MCP text content
 * carrying the JSON payload.
 *
 * `createServer` does NOT connect a transport — the caller wires stdio (in
 * `index.ts`) or an in-memory transport (in the integration test). Keeping the
 * transport injectable is what makes the in-process round-trip test possible.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CatalogEntry } from "./catalog/types.js";
import type { Ranker } from "./ranker/ranker.js";
import type { SecretProvider } from "./secrets/provider.js";
import { toToolError } from "./errors/to-tool-error.js";
import { searchCapabilities } from "./handlers/search-capabilities.js";
import { getSchema } from "./handlers/get-schema.js";
import { resolveSkill } from "./handlers/resolve-skill.js";
import { execute } from "./handlers/execute.js";

/** Everything the meta-tools need, injected for testability. */
export interface ServerDeps {
  index: CatalogEntry[];
  ranker: Ranker;
  secrets: SecretProvider;
}

/** Wrap a successful JSON payload as an MCP text-content result. */
function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Run an async producer through the error choke point. */
async function guarded(produce: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await produce());
  } catch (e) {
    return toToolError(e);
  }
}

/**
 * Create the gateway {@link McpServer} with the 4 meta-tools registered.
 *
 * @returns the server; the caller connects a transport.
 */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({
    name: "capability-gateway",
    version: "0.0.1",
  });

  server.registerTool(
    "search_capabilities",
    {
      description:
        "Rank the capability catalog (skills + tools) for a query. Returns tiny rows {id, kind, name, description} — the entry point of the discovery loop.",
      inputSchema: {
        query: z.string(),
        k: z.number().int().positive().optional(),
      },
    },
    (args) => guarded(() => searchCapabilities(args, { index: deps.index, ranker: deps.ranker })),
  );

  server.registerTool(
    "get_schema",
    {
      description:
        "Get the static schema/detail for an id: a skill's description + references, or a tool's input/output JSON Schema + auth (no wrapper module is loaded).",
      inputSchema: {
        id: z.string(),
      },
    },
    (args) => guarded(() => getSchema(args, { index: deps.index })),
  );

  server.registerTool(
    "resolve_skill",
    {
      description:
        "Return a skill's full SKILL.md body and its reference file list. Errors if the id is a tool.",
      inputSchema: {
        id: z.string(),
      },
    },
    (args) => guarded(() => resolveSkill(args, { index: deps.index })),
  );

  server.registerTool(
    "execute",
    {
      description:
        "Execute a tool by id with the given args: validates input, injects secrets, runs the wrapper handler, validates output. Errors if the id is a skill.",
      inputSchema: {
        id: z.string(),
        args: z.unknown(),
      },
    },
    (args) =>
      guarded(() =>
        execute(
          { id: args.id, args: args.args },
          { index: deps.index, secrets: deps.secrets },
        ),
      ),
  );

  return server;
}
