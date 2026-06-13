#!/usr/bin/env node
/**
 * Bin entry for `@praetorian/capability-gateway`.
 *
 * Boots the gateway as an MCP server over stdio:
 *   1. load + validate `gateway.config.yaml` (default `./gateway.config.yaml`,
 *      overridable via argv[2] or `GATEWAY_CONFIG`),
 *   2. build the catalog index from `config.catalog.root`,
 *   3. assert no manifest/wrapper drift (refuses to start on drift),
 *   4. build the ranker (keyword in P0) and index the catalog,
 *   5. build the secret provider (env in P0),
 *   6. create the MCP server and connect a stdio transport.
 *
 * ALL logs go to stderr — stdout is the MCP stdio framing channel; a stray
 * `console.log` would corrupt the protocol (correctness, not style).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildIndex } from "./catalog/catalog-index.js";
import { assertNoDrift } from "./execute/drift.js";
import { rankerFromConfig } from "./ranker/factory.js";
import { secretsFromConfig } from "./secrets/factory.js";
import { createServer } from "./server.js";

function configPath(): string {
  return process.argv[2] ?? process.env.GATEWAY_CONFIG ?? "./gateway.config.yaml";
}

async function main(): Promise<void> {
  const path = configPath();
  const config = loadConfig(path);
  console.error(`[capability-gateway] config: ${path}`);

  const index = buildIndex(config.catalog.root);
  console.error(`[capability-gateway] indexed ${index.length} entries from ${config.catalog.root}`);

  await assertNoDrift(index);

  const ranker = rankerFromConfig(config.search);
  await ranker.index(index);

  const secrets = secretsFromConfig(config.secrets);

  const server = createServer({ index, ranker, secrets });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[capability-gateway] listening on stdio");
}

main().catch((e: unknown) => {
  console.error("[capability-gateway] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
