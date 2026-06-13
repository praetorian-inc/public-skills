import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { rankerFromConfig } from "../src/ranker/factory.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { createServer } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogRoot = join(here, "fixtures/.agentsmesh");

/** Parse the JSON payload out of an MCP tool-call result's first text block. */
function payload(result: unknown): unknown {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content[0].text ?? "null");
}

let client: Client;

beforeAll(async () => {
  const index = buildIndex(catalogRoot);
  const ranker = rankerFromConfig({ ranker: "keyword" });
  await ranker.index(index);
  const server = createServer({ index, ranker, secrets: new EnvProvider() });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

describe("MCP round-trip", () => {
  it("exposes exactly the 4 gateway tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["execute", "get_schema", "resolve_skill", "search_capabilities"]);
  });

  it("drives the skill path: search → get_schema → resolve_skill", async () => {
    const search = await client.callTool({
      name: "search_capabilities",
      arguments: { query: "yagni" },
    });
    const hits = payload(search) as Array<{ id: string; kind: string }>;
    const yagni = hits.find((h) => h.id === "adhering-to-yagni");
    expect(yagni).toMatchObject({ kind: "skill" });

    const schema = await client.callTool({
      name: "get_schema",
      arguments: { id: "adhering-to-yagni" },
    });
    expect(payload(schema)).toMatchObject({ kind: "skill" });

    const resolved = await client.callTool({
      name: "resolve_skill",
      arguments: { id: "adhering-to-yagni" },
    });
    const body = payload(resolved) as { markdown: string; references: string[] };
    expect(body.markdown).toContain("# Adhering to YAGNI");
    expect(body.references).toContain("references/checklist.md");
  });

  it("drives the tool path: get_schema → execute echo", async () => {
    const schema = await client.callTool({
      name: "get_schema",
      arguments: { id: "echo.echo" },
    });
    expect(payload(schema)).toMatchObject({ kind: "tool" });

    const exec = await client.callTool({
      name: "execute",
      arguments: { id: "echo.echo", args: { text: "hello" } },
    });
    expect(exec.isError).toBeFalsy();
    expect(payload(exec)).toEqual({ text: "hello" });
  });

  it("returns a structured coded error (not a raw throw) for kind_mismatch", async () => {
    const exec = await client.callTool({
      name: "execute",
      arguments: { id: "adhering-to-yagni", args: {} },
    });
    expect(exec.isError).toBe(true);
    expect((payload(exec) as { code: string }).code).toBe("kind_mismatch");
  });
});
