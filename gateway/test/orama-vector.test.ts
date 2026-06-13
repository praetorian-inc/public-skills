/**
 * Group H — OramaVectorRanker (semantic + hybrid) over orama.
 *
 * A FAKE embedder returns deterministic vectors so tests are offline + stable:
 * each catalog/query text maps to a fixed unit-ish vector. This lets us assert
 * ranking by vector proximity without a real embedding model.
 *
 *   - semantic: the doc whose vector is closest to the query vector ranks #1.
 *   - hybrid:   term + vector both contribute.
 *   - similarity threshold filters low-similarity hits.
 *   - empty query / empty catalog → [] (matches orama-keyword.ts:60).
 */
import { describe, it, expect } from "vitest";
import type { CatalogEntry } from "../src/catalog/types.js";
import type { Embedder } from "../src/ranker/embedder.js";
import { EmbeddingCache } from "../src/ranker/embedding-cache.js";
import { OramaVectorRanker } from "../src/ranker/orama-vector.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Deterministic fake embedder: maps a few known phrases to fixed 3-D vectors.
 * Unknown text → a zero-ish default so it never out-ranks a real match.
 */
const VECTORS: Record<string, number[]> = {
  "adhering to yagni scope discipline": [1, 0, 0],
  "dry dont repeat yourself refactoring": [0, 1, 0],
  "kiss keep it simple": [0, 0, 1],
  // queries
  "yagni": [0.95, 0.05, 0],
  "simple": [0, 0.05, 0.95],
  "repeat": [0, 0.95, 0.05],
};

class FakeEmbedder implements Embedder {
  public calls: string[][] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((t) => VECTORS[t] ?? [0.01, 0.01, 0.01]);
  }
}

function fixtureEntries(): CatalogEntry[] {
  return [
    {
      id: "adhering-to-yagni",
      kind: "skill",
      name: "Adhering to YAGNI",
      description: "adhering to yagni scope discipline",
      path: "skills/adhering-to-yagni",
    },
    {
      id: "adhering-to-dry",
      kind: "skill",
      name: "Adhering to DRY",
      description: "dry dont repeat yourself refactoring",
      path: "skills/adhering-to-dry",
    },
    {
      id: "preferring-simple-solutions",
      kind: "skill",
      name: "Preferring Simple Solutions",
      description: "kiss keep it simple",
      path: "skills/preferring-simple-solutions",
    },
  ];
}

let cacheDir: string;
function freshCache(): EmbeddingCache {
  cacheDir = mkdtempSync(join(tmpdir(), "gw-vec-"));
  return new EmbeddingCache(cacheDir);
}
function cleanup(): void {
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
}

describe("OramaVectorRanker — semantic", () => {
  it("ranks the vector-closest doc #1", async () => {
    const ranker = new OramaVectorRanker("semantic", new FakeEmbedder(), freshCache(), 3);
    await ranker.index(fixtureEntries());
    try {
      const results = await ranker.search("yagni", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("adhering-to-yagni");
      expect(typeof results[0].score).toBe("number");
    } finally {
      cleanup();
    }
  });

  it("ranks the 'simple' query closest to the kiss doc", async () => {
    const ranker = new OramaVectorRanker("semantic", new FakeEmbedder(), freshCache(), 3);
    await ranker.index(fixtureEntries());
    try {
      const results = await ranker.search("simple", 10);
      expect(results[0].id).toBe("preferring-simple-solutions");
    } finally {
      cleanup();
    }
  });

  it("returns descending scores, at most k", async () => {
    const ranker = new OramaVectorRanker("semantic", new FakeEmbedder(), freshCache(), 3);
    await ranker.index(fixtureEntries());
    try {
      const results = await ranker.search("yagni", 2);
      expect(results.length).toBeLessThanOrEqual(2);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    } finally {
      cleanup();
    }
  });

  it("returns [] for an empty query (no embedder call)", async () => {
    const embedder = new FakeEmbedder();
    const ranker = new OramaVectorRanker("semantic", embedder, freshCache(), 3);
    await ranker.index(fixtureEntries());
    try {
      const indexCalls = embedder.calls.length;
      expect(await ranker.search("", 10)).toEqual([]);
      expect(await ranker.search("   ", 10)).toEqual([]);
      // No query embedding for a blank query.
      expect(embedder.calls.length).toBe(indexCalls);
    } finally {
      cleanup();
    }
  });

  it("returns [] when the catalog is empty", async () => {
    const ranker = new OramaVectorRanker("semantic", new FakeEmbedder(), freshCache(), 3);
    await ranker.index([]);
    try {
      expect(await ranker.search("yagni", 10)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("applies the similarity threshold to filter distant hits", async () => {
    // A high threshold should drop docs whose vectors are far from the query.
    const ranker = new OramaVectorRanker("semantic", new FakeEmbedder(), freshCache(), 3, 0.99);
    await ranker.index(fixtureEntries());
    try {
      const results = await ranker.search("yagni", 10);
      // Only the near-parallel yagni doc clears a 0.99 cosine threshold.
      expect(results.map((r) => r.id)).toEqual(["adhering-to-yagni"]);
    } finally {
      cleanup();
    }
  });
});

describe("OramaVectorRanker — hybrid", () => {
  it("blends term + vector and returns ranked hits", async () => {
    const ranker = new OramaVectorRanker("hybrid", new FakeEmbedder(), freshCache(), 3);
    await ranker.index(fixtureEntries());
    try {
      // "yagni" matches the yagni doc by BOTH term (description contains "yagni")
      // and vector proximity → it must rank.
      const results = await ranker.search("yagni", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results.map((r) => r.id)).toContain("adhering-to-yagni");
      expect(results[0].id).toBe("adhering-to-yagni");
    } finally {
      cleanup();
    }
  });

  it("returns [] for empty query and empty catalog (hybrid)", async () => {
    const r1 = new OramaVectorRanker("hybrid", new FakeEmbedder(), freshCache(), 3);
    await r1.index(fixtureEntries());
    try {
      expect(await r1.search("", 10)).toEqual([]);
    } finally {
      cleanup();
    }

    const r2 = new OramaVectorRanker("hybrid", new FakeEmbedder(), freshCache(), 3);
    await r2.index([]);
    try {
      expect(await r2.search("yagni", 10)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
