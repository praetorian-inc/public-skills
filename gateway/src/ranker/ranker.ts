/**
 * The ranking strategy `search_capabilities` queries.
 *
 * A `Ranker` indexes the catalog once at startup, then answers keyword (P0) /
 * semantic / hybrid (P1+) queries. All three modes are backed by one engine
 * (orama). The interface is async because orama's `create`/`insert`/`search`
 * return Promises (B1).
 */
import type { CatalogEntry } from "../catalog/types.js";

/** A single ranked hit: the catalog `id` and its relevance `score` (higher = better). */
export interface RankedHit {
  id: string;
  score: number;
}

/** Indexes a catalog and answers ranked queries over it. */
export interface Ranker {
  /** Build the index over `entries`. Awaited once at startup. */
  index(entries: CatalogEntry[]): Promise<void>;
  /** Return the top-`k` hits for `query`, ranked by descending score. */
  search(query: string, k: number): Promise<RankedHit[]>;
}
