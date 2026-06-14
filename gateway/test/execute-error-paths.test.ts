/**
 * HIGH-2 — invalid_output via the real execute path.
 * MEDIUM-2 — wrapper_load_failed: missing-file and import-throw branches.
 * LOW — missing_secret end-to-end (tool that declares auth but key absent).
 *
 * All fixture catalogs are built in isolated mkdtempSync directories so they
 * cannot perturb the shared test/fixtures/.agentsmesh entry counts.
 *
 * Each test exercises the REAL executeTool / assertNoDrift / createServer path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { executeTool } from "../src/execute/runner.js";
import { assertNoDrift } from "../src/execute/drift.js";
import { rankerFromConfig } from "../src/ranker/factory.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { createServer } from "../src/server.js";
import type { CatalogEntry } from "../src/catalog/types.js";

// ---- tmp-dir housekeeping --------------------------------------------------

let tmpDirs: string[] = [];

function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gw-test-"));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---- helpers ---------------------------------------------------------------

function writeManifest(dir: string, json: object): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(json), "utf8");
}

function writeWrapper(dir: string, src: string): void {
  writeFileSync(join(dir, "wrapper.ts"), src, "utf8");
}

// ============================================================================
// HIGH-2 — invalid_output
// ============================================================================

/**
 * A wrapper whose handler returns `{ result: "this-is-a-string" }` but whose
 * declared output schema is `z.object({ result: z.number() })`. The schemaHash
 * was pre-computed with:
 *   input  = z.object({ x: z.string() })
 *   output = z.object({ result: z.number() })
 * hash = 1d9efb5b7b2e8747180b5867d1b0efd2ccf0c4829ce3a5541c714793d1b3de5e
 */
const BAD_OUTPUT_HASH = "1d9efb5b7b2e8747180b5867d1b0efd2ccf0c4829ce3a5541c714793d1b3de5e";

const BAD_OUTPUT_WRAPPER_SRC = `
import { z } from "zod";
export const badOutput = {
  id: "bad-output.badOutput",
  name: "badOutput",
  description: "Returns wrong type to trigger invalid_output.",
  input: z.object({ x: z.string() }),
  output: z.object({ result: z.number() }),
  handler: async (_args) => ({ result: "this-is-a-string-not-a-number" }),
};
`;

describe("HIGH-2: invalid_output via executeTool", () => {
  let badCatalog: string;
  let index: CatalogEntry[];

  beforeAll(() => {
    const tmp = makeTmp();
    badCatalog = join(tmp, ".agentsmesh");
    const svcDir = join(badCatalog, "tools", "bad-output");
    mkdirSync(svcDir, { recursive: true });

    writeManifest(svcDir, {
      manifestVersion: 1,
      service: "bad-output",
      tools: [{
        id: "bad-output.badOutput",
        name: "badOutput",
        description: "Returns wrong type to trigger invalid_output.",
        inputSchema: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
        outputSchema: {
          type: "object",
          properties: { result: { type: "number" } },
          required: ["result"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
        entry: "wrapper.ts#badOutput",
        schemaHash: BAD_OUTPUT_HASH,
      }],
    });
    writeWrapper(svcDir, BAD_OUTPUT_WRAPPER_SRC);
    index = buildIndex(badCatalog);
  });

  it("rejects with code invalid_output when handler returns wrong type", async () => {
    const secrets = new EnvProvider();
    await expect(
      executeTool("bad-output.badOutput", { x: "hello" }, { index, secrets }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("returns invalid_output over MCP round-trip (InMemoryTransport)", async () => {
    const ranker = rankerFromConfig({ ranker: "keyword" });
    await ranker.index(index);
    const server = createServer({
      index,
      ranker,
      secrets: new EnvProvider(),
      // This test exercises only `execute`; run_code is unused here.
      runCode: async () => undefined,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-invalid-output", version: "0.0.1" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "execute",
      arguments: { id: "bad-output.badOutput", args: { x: "hello" } },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text) as { code: string };
    expect(body.code).toBe("invalid_output");
  });
});

// ============================================================================
// MEDIUM-2a — wrapper_load_failed: manifest exists but NO wrapper file
// ============================================================================

describe("MEDIUM-2a: wrapper_load_failed when no wrapper file exists", () => {
  it("rejects with code wrapper_load_failed when no wrapper.ts or wrapper.js in service dir", async () => {
    // Craft a minimal index entry pointing at a manifest in a dir that has
    // NO wrapper.ts / wrapper.js — exercising the "no wrapper file" branch.
    const tmp = makeTmp();
    const svcDir = join(tmp, "svc");
    mkdirSync(svcDir, { recursive: true });
    const manifestPath = join(svcDir, "manifest.json");
    writeManifest(svcDir, {
      manifestVersion: 1,
      service: "no-wrapper",
      tools: [{
        id: "no-wrapper.tool",
        name: "tool",
        description: "tool with no wrapper file",
        inputSchema: { type: "object", properties: {}, additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" },
        outputSchema: { type: "object", properties: {}, additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" },
        entry: "wrapper.js#tool",
        schemaHash: "00000000000000000000000000000000000000000000000000000000000000aa",
      }],
    });
    // No wrapper.ts or wrapper.js created intentionally.

    const index: CatalogEntry[] = [{
      id: "no-wrapper.tool",
      kind: "tool",
      name: "tool",
      description: "no wrapper",
      path: manifestPath,
    }];
    const secrets = new EnvProvider();

    await expect(
      executeTool("no-wrapper.tool", {}, { index, secrets }),
    ).rejects.toMatchObject({ code: "wrapper_load_failed" });
  });
});

// ============================================================================
// MEDIUM-2b — wrapper_load_failed: wrapper.ts throws at import time
// ============================================================================

const THROWING_WRAPPER_SRC = `
// This module throws at import time.
throw new Error("deliberate import-time error for testing");
`;

const THROWING_WRAPPER_HASH = "1d9efb5b7b2e8747180b5867d1b0efd2ccf0c4829ce3a5541c714793d1b3de5e";

describe("MEDIUM-2b: wrapper_load_failed when wrapper throws at import", () => {
  it("rejects with code wrapper_load_failed when the wrapper module throws on import", async () => {
    const tmp = makeTmp();
    const svcDir = join(tmp, ".agentsmesh", "tools", "throw-on-import");
    mkdirSync(svcDir, { recursive: true });
    const manifestPath = join(svcDir, "manifest.json");
    writeManifest(svcDir, {
      manifestVersion: 1,
      service: "throw-on-import",
      tools: [{
        id: "throw-on-import.thrower",
        name: "thrower",
        description: "module throws at import",
        inputSchema: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
        outputSchema: {
          type: "object",
          properties: { result: { type: "number" } },
          required: ["result"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
        entry: "wrapper.ts#thrower",
        schemaHash: THROWING_WRAPPER_HASH,
      }],
    });
    writeWrapper(svcDir, THROWING_WRAPPER_SRC);

    const index: CatalogEntry[] = [{
      id: "throw-on-import.thrower",
      kind: "tool",
      name: "thrower",
      description: "module throws at import",
      path: manifestPath,
    }];
    const secrets = new EnvProvider();

    await expect(
      executeTool("throw-on-import.thrower", { x: "hi" }, { index, secrets }),
    ).rejects.toMatchObject({ code: "wrapper_load_failed" });
  });
});

// ============================================================================
// LOW — missing_secret end-to-end
// ============================================================================

/**
 * A tool that declares auth: ["SOME_KEY"].  We run it through executeTool with
 * a real EnvProvider but ensure SOME_KEY is absent from process.env.
 *
 * hash pre-computed for input=z.object({x:z.string()}), output=z.object({result:z.string()})
 * = b9ab7a1aa080d494b907803be51c322db3f57b17a0e89c75a7a0019568490a4e
 */
const AUTH_WRAPPER_HASH = "b9ab7a1aa080d494b907803be51c322db3f57b17a0e89c75a7a0019568490a4e";

const AUTH_WRAPPER_SRC = `
import { z } from "zod";
export const authTool = {
  id: "auth-svc.authTool",
  name: "authTool",
  description: "Requires SOME_KEY secret.",
  input: z.object({ x: z.string() }),
  output: z.object({ result: z.string() }),
  auth: ["SOME_KEY"],
  handler: async (_args, ctx) => ({ result: ctx.secrets["SOME_KEY"] }),
};
`;

describe("LOW: missing_secret end-to-end", () => {
  it("rejects with code missing_secret when a declared auth key is absent from env", async () => {
    const tmp = makeTmp();
    const svcDir = join(tmp, ".agentsmesh", "tools", "auth-svc");
    mkdirSync(svcDir, { recursive: true });
    const manifestPath = join(svcDir, "manifest.json");
    writeManifest(svcDir, {
      manifestVersion: 1,
      service: "auth-svc",
      tools: [{
        id: "auth-svc.authTool",
        name: "authTool",
        description: "Requires SOME_KEY secret.",
        inputSchema: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
        outputSchema: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
        auth: ["SOME_KEY"],
        entry: "wrapper.ts#authTool",
        schemaHash: AUTH_WRAPPER_HASH,
      }],
    });
    writeWrapper(svcDir, AUTH_WRAPPER_SRC);

    const index: CatalogEntry[] = [{
      id: "auth-svc.authTool",
      kind: "tool",
      name: "authTool",
      description: "Requires SOME_KEY secret.",
      path: manifestPath,
    }];

    // Guarantee the key is absent for this test.
    const saved = process.env["SOME_KEY"];
    delete process.env["SOME_KEY"];
    try {
      await expect(
        executeTool("auth-svc.authTool", { x: "hi" }, { index, secrets: new EnvProvider() }),
      ).rejects.toMatchObject({ code: "missing_secret" });
    } finally {
      if (saved !== undefined) process.env["SOME_KEY"] = saved;
    }
  });
});
