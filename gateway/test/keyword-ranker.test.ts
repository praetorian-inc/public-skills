import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { OramaKeywordRanker } from "../src/ranker/orama-keyword.js";
import { rankerFromConfig } from "../src/ranker/factory.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures/.agentsmesh");

describe("OramaKeywordRanker", () => {
  it("ranks the yagni skill #1 for the query 'yagni'", async () => {
    const entries = buildIndex(fixtureRoot);
    const ranker = new OramaKeywordRanker();
    await ranker.index(entries);

    const results = await ranker.search("yagni", 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("adhering-to-yagni");
    expect(typeof results[0].score).toBe("number");
  });

  it("returns at most k results, ranked by descending score", async () => {
    const entries = buildIndex(fixtureRoot);
    const ranker = new OramaKeywordRanker();
    await ranker.index(entries);

    const results = await ranker.search("adhering", 1);

    expect(results.length).toBeLessThanOrEqual(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("returns [] for an empty query", async () => {
    const entries = buildIndex(fixtureRoot);
    const ranker = new OramaKeywordRanker();
    await ranker.index(entries);

    expect(await ranker.search("", 10)).toEqual([]);
    expect(await ranker.search("   ", 10)).toEqual([]);
  });

  it("returns [] when nothing matches", async () => {
    const entries = buildIndex(fixtureRoot);
    const ranker = new OramaKeywordRanker();
    await ranker.index(entries);

    expect(await ranker.search("zzzznotacatalogterm", 10)).toEqual([]);
  });
});

describe("rankerFromConfig", () => {
  it("returns an OramaKeywordRanker for ranker: keyword", () => {
    const ranker = rankerFromConfig({ ranker: "keyword" });
    expect(ranker).toBeInstanceOf(OramaKeywordRanker);
  });

  it("throws config_invalid for ranker: semantic with NO embedding sub-config (WS-3)", () => {
    // WS-3: semantic/hybrid are now implemented, but require an embedding
    // sub-config; absent → a clear config_invalid (not the old P0 "not
    // implemented" throw).
    expect(() => rankerFromConfig({ ranker: "semantic" })).toThrow(GatewayError);
    expect(() => rankerFromConfig({ ranker: "semantic" })).toThrow(/search\.embedding/i);
    try {
      rankerFromConfig({ ranker: "semantic" });
    } catch (e) {
      // A config selection error is config_invalid — NOT manifest_invalid (no manifest involved).
      expect((e as GatewayError).code).toBe("config_invalid");
    }
  });

  it("throws config_invalid for ranker: hybrid with NO embedding sub-config (WS-3)", () => {
    expect(() => rankerFromConfig({ ranker: "hybrid" })).toThrow(GatewayError);
    expect(() => rankerFromConfig({ ranker: "hybrid" })).toThrow(/search\.embedding/i);
  });

  it("throws a clear GatewayError for an unknown ranker value", () => {
    expect(() => rankerFromConfig({ ranker: "bogus" as never })).toThrow(GatewayError);
  });
});
