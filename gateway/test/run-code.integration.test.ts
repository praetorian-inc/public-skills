/**
 * Group D — run_code end-to-end over an in-process MCP Client/Server.
 *
 * The server now exposes EXACTLY 5 tools (the P0 four + run_code), and a
 * run_code round-trip that composes two capability calls returns the composed
 * result through the normal MCP envelope (no raw throw; guarded() discipline).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { rankerFromConfig } from "../src/ranker/factory.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { Sandbox } from "../src/sandbox/sandbox.js";
import { createServer } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogRoot = join(here, "fixtures/.agentsmesh");

function payload(result: unknown): unknown {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content[0].text ?? "null");
}

let client: Client;

beforeAll(async () => {
  const index = buildIndex(catalogRoot);
  const ranker = rankerFromConfig({ ranker: "keyword" });
  await ranker.index(index);
  const sandbox = new Sandbox({ index, secrets: new EnvProvider() });
  const server = createServer({
    index,
    ranker,
    secrets: new EnvProvider(),
    runCode: (source) => sandbox.run(source),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

describe("run_code MCP round-trip", () => {
  it("exposes exactly the 5 gateway tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "execute",
      "get_schema",
      "resolve_skill",
      "run_code",
      "search_capabilities",
    ]);
  });

  it("composes two capability calls in one run_code program", async () => {
    const result = await client.callTool({
      name: "run_code",
      arguments: {
        source: `(() => {
          const a = caps.echo.echo({ text: "foo" });
          const b = caps.echo.echo({ text: "bar" });
          return { joined: a.text + b.text };
        })()`,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(payload(result)).toEqual({ joined: "foobar" });
  });

  it("returns a structured coded error (not a raw throw) for empty source", async () => {
    const result = await client.callTool({ name: "run_code", arguments: { source: "" } });
    expect(result.isError).toBe(true);
    expect((payload(result) as { code: string }).code).toBe("invalid_args");
  });
});
