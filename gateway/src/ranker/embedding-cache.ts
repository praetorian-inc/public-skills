/**
 * Disk-backed embedding cache for the semantic/hybrid rankers.
 *
 * A description's embedding is expensive to compute (an HTTP call or a local
 * model run), so we cache it keyed by `sha256(description)` — the description is
 * the ONLY field embedded, so its hash is the exact re-embed trigger: a changed
 * description hashes differently and misses; an unchanged one hits. This makes a
 * restart re-embed nothing when the catalog text is stable (the real cost D5
 * calls out), and re-embed only the entries whose description changed.
 *
 * The cache is a single JSON map `{ sha256(description) → number[] }` at
 * `<cacheDir>/cache.json`. It is loaded once on construct and written on
 * {@link flush}. Reuses the `node:crypto` sha256 idiom from `schema-hash.ts`
 * (no new dependency). keyword ranking does NOT use this cache.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Cache file name under the configured cache dir. */
const CACHE_FILE = "cache.json";

/** sha256 hex of the description text — the cache key + invalidation trigger. */
function descriptionHash(description: string): string {
  return createHash("sha256").update(description).digest("hex");
}

export class EmbeddingCache {
  readonly #dir: string;
  readonly #path: string;
  readonly #map: Map<string, number[]>;

  /**
   * @param cacheDir - directory holding `cache.json`. Created on first write if
   *   absent. Loaded eagerly so existing vectors survive a restart.
   */
  constructor(cacheDir: string) {
    this.#dir = cacheDir;
    this.#path = join(cacheDir, CACHE_FILE);
    this.#map = this.#load();
  }

  /** Cached vector for `description`, or `undefined` on a miss. */
  get(description: string): number[] | undefined {
    return this.#map.get(descriptionHash(description));
  }

  /** Cache `vector` for `description` (call {@link flush} to persist). */
  set(description: string, vector: number[]): void {
    this.#map.set(descriptionHash(description), vector);
  }

  /** Write the in-memory map to disk, creating the cache dir if needed. */
  flush(): void {
    if (!existsSync(this.#dir)) {
      mkdirSync(this.#dir, { recursive: true });
    }
    const obj: Record<string, number[]> = {};
    for (const [hash, vector] of this.#map) {
      obj[hash] = vector;
    }
    writeFileSync(this.#path, JSON.stringify(obj), "utf8");
  }

  #load(): Map<string, number[]> {
    if (!existsSync(this.#path)) {
      return new Map();
    }
    // A corrupt cache file should not be fatal — treat it as empty and let the
    // next flush overwrite it. (The catalog re-embeds; correctness is preserved.)
    try {
      const obj = JSON.parse(readFileSync(this.#path, "utf8")) as Record<string, number[]>;
      return new Map(Object.entries(obj));
    } catch {
      return new Map();
    }
  }
}
