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
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { GatewayConfig } from "./config.js";
import { configFromObject, loadConfig } from "./config.js";

// `run_code`'s isolated-vm sandbox needs the process launched with
// `--no-node-snapshot` (Node >= 20). The published `bin` is invoked as plain
// `node dist/index.js`, so re-exec ourselves ONCE with the flag when it is not
// already active — `stdio: "inherit"` makes the child transparently own the MCP
// stdio framing, so this is invisible to the client. The `dev`/`test` scripts
// already pass the flag (via argv / NODE_OPTIONS) and so skip the re-exec.
const NO_NODE_SNAPSHOT = "--no-node-snapshot";
function reexecWithNodeSnapshotDisabledIfNeeded(): void {
  const active =
    process.execArgv.includes(NO_NODE_SNAPSHOT) ||
    (process.env.NODE_OPTIONS ?? "").split(/\s+/).includes(NO_NODE_SNAPSHOT);
  if (active || process.env.GATEWAY_NO_REEXEC === "1") return;

  const child = spawnSync(
    process.execPath,
    [NO_NODE_SNAPSHOT, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, GATEWAY_NO_REEXEC: "1" } },
  );
  process.exit(child.status ?? 1);
}
reexecWithNodeSnapshotDisabledIfNeeded();
import { buildIndex } from "./catalog/catalog-index.js";
import { assertNoDrift } from "./execute/drift.js";
import { rankerFromConfig } from "./ranker/factory.js";
import { secretsFromConfig } from "./secrets/factory.js";
import { Sandbox } from "./sandbox/sandbox.js";
import { createServer } from "./server.js";

const DEFAULT_CONFIG = "./gateway.config.yaml";

/**
 * The resolved config path and whether the adopter chose it explicitly (argv or
 * `GATEWAY_CONFIG`) vs. falling through to the `./gateway.config.yaml` default.
 * The distinction drives the bundled-catalog fallback below: we only substitute
 * the packaged catalog when the user gave NO config of their own.
 */
function resolveConfigPath(): { path: string; explicit: boolean } {
  const fromArg = process.argv[2] ?? process.env.GATEWAY_CONFIG;
  return fromArg !== undefined
    ? { path: fromArg, explicit: true }
    : { path: DEFAULT_CONFIG, explicit: false };
}

/**
 * Absolute path to the catalog bundled into the published package
 * (`dist/bundled-catalog`, written by `scripts/bundle-catalog.ts`). Resolved
 * relative to THIS module (`import.meta.url`), never cwd, so it points at the
 * package's own copy regardless of where the bin is invoked from. Returns the
 * path only if it actually exists (it won't when running from source via tsx).
 */
function bundledCatalogRoot(): string | undefined {
  const root = join(dirname(fileURLToPath(import.meta.url)), "bundled-catalog");
  return existsSync(root) ? root : undefined;
}

/**
 * Decide the effective config:
 *   - an explicit config path (argv / GATEWAY_CONFIG)  → load it (as today);
 *   - a present `./gateway.config.yaml`                → load it (as today);
 *   - NEITHER, but a bundled catalog is packaged       → default config whose
 *     `catalog.root` points at the bundled catalog (so `npx` works out of the
 *     box — O5);
 *   - none of the above                                → load the default path
 *     and let the missing-file error surface (unchanged behaviour).
 */
function resolveConfig(): { config: GatewayConfig; source: string } {
  const { path, explicit } = resolveConfigPath();
  if (explicit || existsSync(path)) {
    return { config: loadConfig(path), source: path };
  }
  const bundled = bundledCatalogRoot();
  if (bundled !== undefined) {
    return {
      config: configFromObject({ catalog: { root: bundled } }),
      source: `bundled catalog (no config file; ${bundled})`,
    };
  }
  // No bundle (running from source) and no config file: preserve the original
  // behaviour — load the default path so the same missing-file error surfaces.
  return { config: loadConfig(path), source: path };
}

async function main(): Promise<void> {
  const { config, source } = resolveConfig();
  console.error(`[capability-gateway] config: ${source}`);

  const index = buildIndex(config.catalog.root);
  console.error(`[capability-gateway] indexed ${index.length} entries from ${config.catalog.root}`);

  await assertNoDrift(index);

  const ranker = rankerFromConfig(config.search);
  await ranker.index(index);

  const secrets = secretsFromConfig(config.secrets);

  // The sandbox builds its capability bridge from the SAME index + secrets the
  // `execute` path uses; isolated-vm is lazy-imported on first run_code call.
  // Resource caps come from config.sandbox (defaulted).
  const sandbox = new Sandbox({
    index,
    secrets,
    limits: { memoryLimitMb: config.sandbox.memoryLimitMb, timeoutMs: config.sandbox.timeoutMs },
  });

  const server = createServer({
    index,
    ranker,
    secrets,
    runCode: (source) => sandbox.run(source),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[capability-gateway] listening on stdio");
}

main().catch((e: unknown) => {
  console.error("[capability-gateway] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
