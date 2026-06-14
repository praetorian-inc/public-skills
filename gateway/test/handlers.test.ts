import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { rankerFromConfig } from "../src/ranker/factory.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import type { Ranker } from "../src/ranker/ranker.js";
import { searchCapabilities } from "../src/handlers/search-capabilities.js";
import { getSchema } from "../src/handlers/get-schema.js";
import { resolveSkill } from "../src/handlers/resolve-skill.js";
import { execute } from "../src/handlers/execute.js";
import { GatewayError, toToolError } from "../src/errors/to-tool-error.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogRoot = join(here, "fixtures/.agentsmesh");

const index = buildIndex(catalogRoot);
const secrets = new EnvProvider();
let ranker: Ranker;

beforeAll(async () => {
  ranker = rankerFromConfig({ ranker: "keyword" });
  await ranker.index(index);
});

describe("search_capabilities", () => {
  it("returns the yagni skill for query 'yagni' without a path field", async () => {
    const hits = await searchCapabilities({ query: "yagni" }, { index, ranker });
    const yagni = hits.find((h) => h.id === "adhering-to-yagni");
    expect(yagni).toBeDefined();
    expect(yagni).toMatchObject({ id: "adhering-to-yagni", kind: "skill", name: "adhering-to-yagni" });
    // path must be omitted from the discovery response.
    expect((yagni as Record<string, unknown>).path).toBeUndefined();
  });

  it("caps k at 25", async () => {
    const hits = await searchCapabilities({ query: "the", k: 1000 }, { index, ranker });
    expect(hits.length).toBeLessThanOrEqual(25);
  });

  it("truncates long descriptions to the budget", async () => {
    const hits = await searchCapabilities({ query: "yagni" }, { index, ranker });
    for (const h of hits) {
      expect(h.description.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("get_schema", () => {
  it("returns description + references for a skill", async () => {
    const detail = await getSchema({ id: "adhering-to-yagni" }, { index });
    expect(detail).toMatchObject({ kind: "skill" });
    expect((detail as { description: string }).description.length).toBeGreaterThan(0);
    expect((detail as { references: string[] }).references).toContain("references/checklist.md");
  });

  it("returns input/output JSON-Schema + auth for a tool (no module load)", async () => {
    const detail = await getSchema({ id: "echo.echo" }, { index });
    expect(detail).toMatchObject({ kind: "tool", auth: [] });
    const d = detail as { inputSchema: { properties?: Record<string, unknown> }; outputSchema: { properties?: Record<string, unknown> } };
    expect(d.inputSchema.properties).toHaveProperty("text");
    expect(d.outputSchema.properties).toHaveProperty("text");
  });

  it("throws unknown_id for an absent id", async () => {
    await expect(getSchema({ id: "nope" }, { index })).rejects.toMatchObject({ code: "unknown_id" });
  });
});

describe("resolve_skill", () => {
  it("returns markdown + references for a real skill", async () => {
    const out = await resolveSkill({ id: "adhering-to-yagni" }, { index });
    expect(out.markdown).toContain("# Adhering to YAGNI");
    expect(out.references).toContain("references/checklist.md");
  });

  it("throws kind_mismatch when id is a tool", async () => {
    await expect(resolveSkill({ id: "echo.echo" }, { index })).rejects.toMatchObject({
      code: "kind_mismatch",
    });
  });

  it("throws unknown_id for an absent id", async () => {
    await expect(resolveSkill({ id: "nope" }, { index })).rejects.toMatchObject({
      code: "unknown_id",
    });
  });
});

describe("execute", () => {
  it("round-trips the echo tool", async () => {
    const out = await execute({ id: "echo.echo", args: { text: "hello" } }, { index, secrets });
    expect(out).toEqual({ text: "hello" });
  });

  it("throws kind_mismatch when id is a skill", async () => {
    await expect(
      execute({ id: "adhering-to-yagni", args: {} }, { index, secrets }),
    ).rejects.toMatchObject({ code: "kind_mismatch" });
  });

  it("throws invalid_args on bad args", async () => {
    await expect(
      execute({ id: "echo.echo", args: { text: 123 } }, { index, secrets }),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("throws unknown_id on an absent id", async () => {
    await expect(
      execute({ id: "nope.nope", args: {} }, { index, secrets }),
    ).rejects.toMatchObject({ code: "unknown_id" });
  });
});

describe("toToolError funnel", () => {
  it("maps a coded GatewayError to a structured MCP error result", () => {
    const result = toToolError(new GatewayError("kind_mismatch", "boom"));
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.code).toBe("kind_mismatch");
  });
});
