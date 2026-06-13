/**
 * Group I — rankerFromConfig wiring for semantic/hybrid + cache-invalidation.
 *
 * - rankerFromConfig({ranker:"semantic", embedding:{…}}) returns a vector ranker.
 * - rankerFromConfig({ranker:"hybrid",   embedding:{…}}) returns a vector ranker.
 * - ranker:"keyword" still returns an OramaKeywordRanker (P0 regression guard).
 * - cache-invalidation proof: a second index() over an UNCHANGED catalog makes
 *   ZERO embedder calls (the persisted cache hits every description).
 *
 * Tests inject a deterministic fake embedder so they stay offline.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogEntry } from "../src/catalog/types.js";
import type { Embedder } from "../src/ranker/embedder.js";
import { rankerFromConfig } from "../src/ranker/factory.js";
import { OramaKeywordRanker } from "../src/ranker/orama-keyword.js";
import { OramaVectorRanker } from "../src/ranker/orama-vector.js";

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "gw-factory-vec-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

class CountingEmbedder implements Embedder {
  public textsEmbedded = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.textsEmbedded += texts.length;
    return texts.map((_, i) => [i + 1, 0, 0]);
  }
}

function embeddingCfg() {
  return {
    backend: "api" as const,
    endpoint: "https://api.example.com/v1/embeddings",
    apiKeyEnv: "EMBED_API_KEY",
    dimensions: 3,
    cacheDir,
  };
}

const entries: CatalogEntry[] = [
  { id: "a", kind: "skill", name: "Alpha", description: "alpha desc", path: "skills/a" },
  { id: "b", kind: "skill", name: "Beta", description: "beta desc", path: "skills/b" },
];

describe("rankerFromConfig — semantic/hybrid (Group I)", () => {
  it("returns an OramaVectorRanker for ranker: semantic", () => {
    const ranker = rankerFromConfig(
      { ranker: "semantic", embedding: embeddingCfg() },
      { embedder: new CountingEmbedder() },
    );
    expect(ranker).toBeInstanceOf(OramaVectorRanker);
  });

  it("returns an OramaVectorRanker for ranker: hybrid", () => {
    const ranker = rankerFromConfig(
      { ranker: "hybrid", embedding: embeddingCfg() },
      { embedder: new CountingEmbedder() },
    );
    expect(ranker).toBeInstanceOf(OramaVectorRanker);
  });

  it("still returns an OramaKeywordRanker for ranker: keyword (P0 regression)", () => {
    const ranker = rankerFromConfig({ ranker: "keyword" });
    expect(ranker).toBeInstanceOf(OramaKeywordRanker);
  });

  it("re-embeds ZERO descriptions on a second index() over an unchanged catalog", async () => {
    const embedder = new CountingEmbedder();

    // First ranker indexes → embeds both descriptions (cache miss), persists.
    const first = rankerFromConfig({ ranker: "semantic", embedding: embeddingCfg() }, { embedder });
    await first.index(entries);
    expect(embedder.textsEmbedded).toBe(2);

    // A SECOND ranker pointed at the SAME cacheDir, same catalog → all hits → no
    // new embed calls (invalidation proof: only changed descriptions re-embed).
    const second = rankerFromConfig({ ranker: "semantic", embedding: embeddingCfg() }, { embedder });
    await second.index(entries);
    expect(embedder.textsEmbedded).toBe(2); // unchanged — zero additional embeds
  });

  it("re-embeds ONLY the changed description on the second index()", async () => {
    const embedder = new CountingEmbedder();
    const first = rankerFromConfig({ ranker: "semantic", embedding: embeddingCfg() }, { embedder });
    await first.index(entries);
    expect(embedder.textsEmbedded).toBe(2);

    const changed: CatalogEntry[] = [
      entries[0],
      { ...entries[1], description: "beta desc CHANGED" },
    ];
    const second = rankerFromConfig({ ranker: "semantic", embedding: embeddingCfg() }, { embedder });
    await second.index(changed);
    expect(embedder.textsEmbedded).toBe(3); // only the one changed description re-embedded
  });
});
