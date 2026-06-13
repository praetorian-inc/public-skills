/**
 * Group D3 (gated) — real local embedder over `@xenova/transformers`.
 *
 * Heavy + native (onnxruntime + sharp ~259M; first run downloads ~23MB). It is
 * SKIPPED unless BOTH:
 *   - XENOVA_INTEGRATION=1 (opt-in switch), and
 *   - `@xenova/transformers` actually resolves (the optionalDependency installed).
 *
 * When it runs it proves the WS-D acceptance criterion: `embedding.backend: local`
 * produces real 384-dim vectors, and a `semantic` ranker over a 2-doc fixture
 * ranks the expected doc #1 — with `env.allowRemoteModels=false` after a warm
 * cache, proving it works OFFLINE.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embedderFromConfig } from "../src/ranker/embedder.js";
import { EmbeddingCache } from "../src/ranker/embedding-cache.js";
import { OramaVectorRanker } from "../src/ranker/orama-vector.js";
import type { CatalogEntry } from "../src/catalog/types.js";

/** True only when the opt-in env is set AND the optional dep is installed. */
async function gateEnabled(): Promise<boolean> {
  if (process.env.XENOVA_INTEGRATION !== "1") return false;
  try {
    await import("@xenova/transformers" as string);
    return true;
  } catch {
    return false;
  }
}

const RUN = await gateEnabled();

const localCfg = {
  backend: "local" as const,
  model: "Xenova/all-MiniLM-L6-v2",
  dimensions: 384,
  cacheDir: "./.gateway-cache/embeddings",
};

describe.skipIf(!RUN)("LocalEmbedder — real @xenova/transformers (gated, offline)", () => {
  // Warm the model-weight cache ONCE with remote allowed (first run downloads
  // ~23MB). Every assertion below then runs with allowRemoteModels=false to
  // prove fully-offline operation against the warm cache.
  beforeAll(async () => {
    const warm = embedderFromConfig(localCfg, { allowRemoteModels: true });
    await warm.embed(["warmup"]);
  }, 120_000);

  it("embeds two docs into 384-dim vectors offline (warm cache)", async () => {
    // After a warm cache, allowRemoteModels=false proves no network is used.
    const embedder = embedderFromConfig(localCfg, { allowRemoteModels: false });
    const vectors = await embedder.embed(["hello world", "goodbye world"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(384);
    expect(vectors[1]).toHaveLength(384);
  });

  it("ranks the topically-closest doc #1 via a semantic ranker (offline)", async () => {
    const embedder = embedderFromConfig(localCfg, { allowRemoteModels: false });
    const cacheDir = mkdtempSync(join(tmpdir(), "gw-local-int-"));
    // Low cosine threshold: real MiniLM similarities between a query and short
    // descriptions sit below orama's 0.8 default; this test asserts RANKING ORDER
    // (programming #1), not an absolute-similarity cutoff.
    const ranker = new OramaVectorRanker("semantic", embedder, new EmbeddingCache(cacheDir), 384, 0.1);
    const entries: CatalogEntry[] = [
      {
        id: "cooking",
        kind: "skill",
        name: "Cooking",
        description: "recipes for baking bread and cake in the oven",
        path: "skills/cooking",
      },
      {
        id: "programming",
        kind: "skill",
        name: "Programming",
        description: "writing software code in typescript and python",
        path: "skills/programming",
      },
    ];
    await ranker.index(entries);
    try {
      const results = await ranker.search("how do I write a function in python", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("programming");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
