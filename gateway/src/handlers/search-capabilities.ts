/**
 * `search_capabilities` handler: rank the catalog for a query and return tiny
 * discovery rows.
 *
 * Behavior (plan: Handler behavior): `await ranker.search(query, k)` → join to
 * the index → return `{id, kind, name, description}[]`, **omitting `path`** and
 * **truncating each `description`** to a fixed budget so the discovery response
 * stays small. `k` is capped at {@link MAX_K}.
 */
import type { CatalogEntry, Kind } from "../catalog/types.js";
import type { Ranker } from "../ranker/ranker.js";

/** Hard cap on returned hits, regardless of requested `k` (plan: should-fix). */
export const MAX_K = 25;
/** Max characters of each `description` returned by search. */
export const DESCRIPTION_BUDGET = 200;

/** A single discovery row — `path` is intentionally absent. */
export interface SearchHit {
  id: string;
  kind: Kind;
  name: string;
  description: string;
}

export interface SearchInput {
  query: string;
  k?: number;
}

export interface SearchDeps {
  index: CatalogEntry[];
  ranker: Ranker;
}

export async function searchCapabilities(
  input: SearchInput,
  deps: SearchDeps,
): Promise<SearchHit[]> {
  const k = Math.min(input.k ?? 10, MAX_K);
  const ranked = await deps.ranker.search(input.query, k);

  const byId = new Map(deps.index.map((e) => [e.id, e]));
  const hits: SearchHit[] = [];
  for (const { id } of ranked) {
    const entry = byId.get(id);
    if (!entry) continue; // ranker returned an id not in the index — skip defensively
    hits.push({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      description: truncate(entry.description, DESCRIPTION_BUDGET),
    });
  }
  return hits;
}

function truncate(s: string, budget: number): string {
  return s.length <= budget ? s : s.slice(0, budget);
}
