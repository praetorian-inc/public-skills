/**
 * Keyword ranker: orama full-text (BM25) over `{ id, name, description }`.
 *
 * This is the P0 default and also the engine the vector/hybrid modes reuse in
 * P1+. The orama instance is kept private; callers see only the {@link Ranker}
 * interface. Empty queries and no-match queries return `[]`.
 */
import { create, insertMultiple, search, type AnyOrama } from "@orama/orama";
import type { CatalogEntry } from "../catalog/types.js";
import type { RankedHit, Ranker } from "./ranker.js";

/**
 * Document stored in the index.
 *
 * `id` is the catalog id (orama uses the document's `id` as its identity).
 * `name`/`description` hold tokenizer-friendly text: orama's default tokenizer
 * treats a hyphenated id like `adhering-to-yagni` as a single token, so a query
 * for `yagni` would miss. We split on non-alphanumerics ({@link toSearchable})
 * so each word is its own token and BM25 can match it.
 */
interface IndexDoc {
  /** The catalog entry id — what we return from {@link search}. */
  id: string;
  /** Searchable text for the entry name (punctuation split into words). */
  name: string;
  /** Searchable text for the entry description (punctuation split into words). */
  description: string;
}

/** Split punctuation/hyphens into spaces so each word is a separate token. */
function toSearchable(text: string): string {
  return text.replace(/[^a-zA-Z0-9]+/g, " ").trim();
}

export class OramaKeywordRanker implements Ranker {
  /** Private orama instance; `undefined` until {@link index} runs. */
  #db: AnyOrama | undefined;

  async index(entries: CatalogEntry[]): Promise<void> {
    const db = await create({
      schema: {
        id: "string",
        name: "string",
        description: "string",
      },
    });

    const docs: IndexDoc[] = entries.map((e) => ({
      id: e.id,
      name: toSearchable(e.name),
      description: toSearchable(e.description),
    }));
    await insertMultiple(db, docs);

    this.#db = db;
  }

  async search(query: string, k: number): Promise<RankedHit[]> {
    const term = query.trim();
    if (term.length === 0 || this.#db === undefined) return [];

    const results = await search(this.#db, {
      term: toSearchable(term),
      properties: ["name", "description"],
      limit: k,
    });

    // orama returns hits sorted by descending score; the catalog id lives on
    // the stored document (orama's own `hit.id` is an internal document id).
    return results.hits.map((hit) => ({
      id: (hit.document as unknown as IndexDoc).id,
      score: hit.score,
    }));
  }
}
