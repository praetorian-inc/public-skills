/**
 * Group G — embedding cache coverage.
 *
 * The cache is a disk-backed JSON map `{ sha256(description) → number[] }`:
 *   - store/load round-trip survives a fresh instance pointed at the same dir.
 *   - a changed description → new hash → miss (re-embed required).
 *   - an unchanged description → hit (no re-embed).
 *
 * The hash keys off the description text ONLY (the only embedded field), reusing
 * the node:crypto sha256 idiom — no new dependency.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingCache } from "../src/ranker/embedding-cache.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gw-embcache-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EmbeddingCache", () => {
  it("returns a miss for an uncached description", () => {
    const cache = new EmbeddingCache(dir);
    expect(cache.get("never seen this text")).toBeUndefined();
  });

  it("stores a vector and returns it for the same description (hit)", () => {
    const cache = new EmbeddingCache(dir);
    cache.set("adhering to yagni", [0.1, 0.2, 0.3]);
    expect(cache.get("adhering to yagni")).toEqual([0.1, 0.2, 0.3]);
  });

  it("persists to disk and reloads in a fresh instance (round-trip)", () => {
    const a = new EmbeddingCache(dir);
    a.set("dry refactoring", [1, 2, 3]);
    a.flush();

    expect(existsSync(join(dir, "cache.json"))).toBe(true);

    const b = new EmbeddingCache(dir);
    expect(b.get("dry refactoring")).toEqual([1, 2, 3]);
  });

  it("treats a changed description as a miss (new hash)", () => {
    const cache = new EmbeddingCache(dir);
    cache.set("original description", [9, 9, 9]);

    // Same key text → hit.
    expect(cache.get("original description")).toEqual([9, 9, 9]);
    // Changed text → different sha256 → miss.
    expect(cache.get("original description CHANGED")).toBeUndefined();
  });

  it("creates the cache directory if it does not exist", () => {
    const nested = join(dir, "deep", "nested", "embeddings");
    const cache = new EmbeddingCache(nested);
    cache.set("text", [0.5]);
    cache.flush();
    expect(existsSync(join(nested, "cache.json"))).toBe(true);
  });
});
