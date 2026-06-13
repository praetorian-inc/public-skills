/**
 * Vector / hybrid ranker: orama vector search (and BM25+vector fusion) over
 * `{ id, name, description, embedding }`.
 *
 * Backs both `semantic` (mode `vector`) and `hybrid` (mode `hybrid`) — one class
 * parameterized by `mode`, since orama does both (KISS, no premature split). It
 * reuses the SAME orama engine, `toSearchable` tokenizer, and `{id, score}` hit
 * mapping as {@link OramaKeywordRanker}; the only additions are a `vector[N]`
 * schema field, precomputed embeddings on each doc, and an embedded query vector.
 *
 * Orama does not compute embeddings — the injected {@link Embedder} does, and the
 * {@link EmbeddingCache} re-embeds ONLY descriptions whose sha256 changed (the
 * cost D5 calls out). The query is embedded fresh each search (queries are
 * ephemeral, not cached). Empty query / empty catalog → `[]`.
 */
import { create, insertMultiple, search, type AnyOrama } from "@orama/orama";
import type { CatalogEntry } from "../catalog/types.js";
import type { RankedHit, Ranker } from "./ranker.js";
import type { Embedder } from "./embedder.js";
import type { EmbeddingCache } from "./embedding-cache.js";
import { toSearchable } from "./orama-keyword.js";

/** Orama's default cosine-similarity threshold for vector search. */
const DEFAULT_SIMILARITY = 0.8;

/** Document stored in the index (mirrors keyword doc + a precomputed embedding). */
interface VectorDoc {
  id: string;
  name: string;
  description: string;
  embedding: number[];
}

export class OramaVectorRanker implements Ranker {
  readonly #mode: "semantic" | "hybrid";
  readonly #embedder: Embedder;
  readonly #cache: EmbeddingCache;
  readonly #dimensions: number;
  readonly #similarity: number;
  #db: AnyOrama | undefined;

  /**
   * @param mode - `semantic` (vector only) or `hybrid` (BM25 + vector).
   * @param embedder - turns description/query text into vectors.
   * @param cache - disk cache; re-embeds only on description-hash miss.
   * @param dimensions - the `vector[N]` size; MUST match the embedder's output.
   * @param similarity - cosine threshold (0–1). Defaults to orama's 0.8.
   */
  constructor(
    mode: "semantic" | "hybrid",
    embedder: Embedder,
    cache: EmbeddingCache,
    dimensions: number,
    similarity: number = DEFAULT_SIMILARITY,
  ) {
    this.#mode = mode;
    this.#embedder = embedder;
    this.#cache = cache;
    this.#dimensions = dimensions;
    this.#similarity = similarity;
  }

  async index(entries: CatalogEntry[]): Promise<void> {
    const db = await create({
      schema: {
        id: "string",
        name: "string",
        description: "string",
        embedding: `vector[${this.#dimensions}]`,
      },
    });

    // Cache-hit → reuse the vector; collect misses to embed in ONE batch.
    const vectors = new Array<number[] | undefined>(entries.length);
    const missIndexes: number[] = [];
    const missTexts: string[] = [];
    entries.forEach((e, i) => {
      const cached = this.#cache.get(e.description);
      if (cached !== undefined) {
        vectors[i] = cached;
      } else {
        missIndexes.push(i);
        missTexts.push(e.description);
      }
    });

    if (missTexts.length > 0) {
      const embedded = await this.#embedder.embed(missTexts);
      embedded.forEach((vec, j) => {
        const idx = missIndexes[j];
        vectors[idx] = vec;
        this.#cache.set(entries[idx].description, vec);
      });
      this.#cache.flush();
    }

    const docs: VectorDoc[] = entries.map((e, i) => ({
      id: e.id,
      name: toSearchable(e.name),
      description: toSearchable(e.description),
      embedding: vectors[i] as number[],
    }));
    await insertMultiple(db, docs);

    this.#db = db;
  }

  async search(query: string, k: number): Promise<RankedHit[]> {
    const term = query.trim();
    if (term.length === 0 || this.#db === undefined) return [];

    const [queryVector] = await this.#embedder.embed([term]);
    const vector = { value: queryVector, property: "embedding" };

    // Build the mode-specific params explicitly so orama's discriminated `search`
    // overloads narrow on the literal `mode` (a `"vector" | "hybrid"` union won't).
    // hybrid fuses BM25 (term) + vector; semantic is vector-only.
    const results =
      this.#mode === "hybrid"
        ? await search(this.#db, {
            mode: "hybrid",
            term: toSearchable(term),
            vector,
            similarity: this.#similarity,
            limit: k,
          })
        : await search(this.#db, {
            mode: "vector",
            vector,
            similarity: this.#similarity,
            limit: k,
          });

    // Same hit mapping as OramaKeywordRanker: the catalog id lives on the stored
    // document (orama's own hit.id is an internal document id).
    return results.hits.map((hit) => ({
      id: (hit.document as unknown as VectorDoc).id,
      score: hit.score,
    }));
  }
}
