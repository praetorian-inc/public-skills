/**
 * SF-1 — Compiled artifact must be able to load a plain `.js` wrapper.
 *
 * This is the most important new test: it proves the JS-preference fix in
 * resolveWrapperPath is respected by the COMPILED server (node dist/index.js),
 * which has no TypeScript loader.
 *
 * Protocol:
 *   1. Build dist/ (assumed done; checked as a precondition).
 *   2. Create a temp catalog INSIDE the project root (so node_modules resolution
 *      works) whose only tool has a wrapper.js file (NOT .ts).  The wrapper
 *      MUST NOT import any gateway TS source — it uses zod from node_modules.
 *   3. Boot `node dist/index.js <config>` over stdio.
 *   4. Drive MCP JSON-RPC over stdio:
 *      a. initialize handshake
 *      b. tools/list → exactly the 4 meta-tools
 *      c. tools/call execute → success (not an error)
 *      d. search_capabilities → indexes the entry
 *   5. Kill the process and verify stdout is pure JSON-RPC.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const distIndex = join(projectRoot, "dist", "index.js");

// ---- schemaHash pre-computed for:
//   input  = z.object({ msg: z.string() })
//   output = z.object({ echoed: z.string() })
const JS_WRAPPER_SCHEMA_HASH = "8e6a2d231a6fa7279d4a00e73e8e3d16504af39fcb29b46e52eeed93f91ebcb6";

/**
 * A plain committed `.js` wrapper. It MUST NOT import any gateway TS source.
 * It imports `zod` from node_modules (available because the catalog lives inside
 * the project root, allowing Node's package resolution to find the project's
 * node_modules).
 */
const JS_WRAPPER_SRC = `
import { z } from "zod";

const input = z.object({ msg: z.string() });
const output = z.object({ echoed: z.string() });

export const jsEcho = {
  id: "js-svc.jsEcho",
  name: "jsEcho",
  description: "Plain JS echo tool.",
  input,
  output,
  handler: async ({ msg }) => ({ echoed: msg }),
};
`;

// Create the temp catalog INSIDE the project so node_modules resolution works.
let tmpCatalogDir: string;
let configPath: string;

beforeAll(() => {
  // Precondition: dist/index.js must exist.
  if (!existsSync(distIndex)) {
    throw new Error(
      `dist/index.js not found — run 'npm run build' before the SF-1 integration test`,
    );
  }

  // Temp dir inside project root so Node's package resolution walks up and
  // finds the project's node_modules/ (where zod lives).
  tmpCatalogDir = mkdtempSync(join(projectRoot, ".tmp-sf1-"));

  const svcDir = join(tmpCatalogDir, ".agentsmesh", "tools", "js-svc");
  mkdirSync(svcDir, { recursive: true });

  // Plain .js wrapper — no TypeScript loader needed.
  writeFileSync(join(svcDir, "wrapper.js"), JS_WRAPPER_SRC, "utf8");

  writeFileSync(join(svcDir, "manifest.json"), JSON.stringify({
    manifestVersion: 1,
    service: "js-svc",
    tools: [{
      id: "js-svc.jsEcho",
      name: "jsEcho",
      description: "Plain JS echo tool.",
      inputSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
      outputSchema: {
        type: "object",
        properties: { echoed: { type: "string" } },
        required: ["echoed"],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
      entry: "wrapper.js#jsEcho",
      schemaHash: JS_WRAPPER_SCHEMA_HASH,
    }],
  }), "utf8");

  configPath = join(tmpCatalogDir, "gateway.config.yaml");
  writeFileSync(configPath, [
    `catalog:`,
    `  root: ${join(tmpCatalogDir, ".agentsmesh")}`,
    `search:`,
    `  ranker: keyword`,
    `secrets:`,
    `  provider: env`,
  ].join("\n"), "utf8");
});

afterAll(() => {
  try { rmSync(tmpCatalogDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---- stdio MCP helpers -----------------------------------------------------

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Boot the compiled gateway, send a sequence of JSON-RPC messages, and collect
 * exactly `expectedCount` responses before killing the server.
 */
async function driveServer(
  messages: RpcRequest[],
  expectedCount: number,
  timeoutMs = 20000,
): Promise<RpcResponse[]> {
  const proc: ChildProcess = spawn(
    process.execPath,
    [distIndex, configPath],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const responses: RpcResponse[] = [];
  let stdoutBuf = "";
  const stderrLines: string[] = [];

  proc.stderr?.on("data", (d: Buffer) => {
    stderrLines.push(d.toString());
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(
        `driveServer timed out after ${timeoutMs}ms.\nStderr:\n${stderrLines.join("")}`
      ));
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rsp = JSON.parse(trimmed) as RpcResponse;
          responses.push(rsp);
          if (responses.length >= expectedCount) {
            clearTimeout(timer);
            proc.kill("SIGTERM");
            resolve();
          }
        } catch {
          // non-JSON line on stdout — violates "nothing but JSON-RPC" contract
          clearTimeout(timer);
          proc.kill("SIGTERM");
          reject(new Error(`non-JSON on gateway stdout: ${trimmed}`));
        }
      }
    });

    proc.on("close", () => {
      clearTimeout(timer);
      resolve();
    });

    // Write messages to stdin AFTER listeners are wired.
    for (const msg of messages) {
      proc.stdin?.write(JSON.stringify(msg) + "\n");
    }
  });

  return responses;
}

// ---- tests -----------------------------------------------------------------

const IT_TIMEOUT = 30_000; // ms — these tests boot a real Node subprocess

describe("SF-1: compiled gateway loads a plain .js wrapper over stdio", () => {
  it("boots, indexes the js wrapper, and exposes exactly the 4 meta-tools", async () => {
    // Send initialize + tools/list; expect 2 responses.
    const responses = await driveServer(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "sf1-test", version: "0.0.1" },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
      ],
      2, // expect initialize response + tools/list response
    );

    const listResponse = responses.find((r) => r.id === 2);
    expect(listResponse, "tools/list response missing").toBeDefined();
    expect(listResponse!.error).toBeUndefined();
    const toolNames = (
      (listResponse!.result as { tools: Array<{ name: string }> }).tools ?? []
    )
      .map((t) => t.name)
      .sort();
    expect(toolNames).toEqual(["execute", "get_schema", "resolve_skill", "search_capabilities"]);
  }, IT_TIMEOUT);

  it("executes the plain .js tool successfully over stdio", async () => {
    const responses = await driveServer(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "sf1-test", version: "0.0.1" },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: { id: "js-svc.jsEcho", args: { msg: "hello from js" } },
          },
        },
      ],
      2,
    );

    const execResponse = responses.find((r) => r.id === 2);
    expect(execResponse, "execute response missing").toBeDefined();
    expect(execResponse!.error).toBeUndefined();

    const result = execResponse!.result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    // Must not be an error result.
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text ?? "null") as unknown;
    expect(body).toEqual({ echoed: "hello from js" });
  }, IT_TIMEOUT);

  it("search_capabilities returns the .js tool entry", async () => {
    const responses = await driveServer(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "sf1-test", version: "0.0.1" },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_capabilities",
            arguments: { query: "echo", k: 10 },
          },
        },
      ],
      2,
    );

    const searchResponse = responses.find((r) => r.id === 2);
    expect(searchResponse, "search_capabilities response missing").toBeDefined();
    expect(searchResponse!.error).toBeUndefined();
    const result = searchResponse!.result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    const hits = JSON.parse(result.content[0].text ?? "[]") as Array<{ id: string }>;
    const jsEchoHit = hits.find((h) => h.id === "js-svc.jsEcho");
    expect(jsEchoHit, "js-svc.jsEcho not found in search hits").toBeDefined();
  }, IT_TIMEOUT);
});
