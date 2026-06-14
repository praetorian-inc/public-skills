/**
 * Build a {@link Ranker} from the resolved `search` config.
 *
 * `keyword` (default) uses BM25 and needs no embedder. `semantic` and `hybrid`
 * (P1, WS-3) share the same orama engine with a vector field: the factory builds
 * the {@link Embedder} (`embedderFromConfig`) and a disk {@link EmbeddingCache}
 * from `search.embedding`, then constructs an {@link OramaVectorRanker}.
 */
import type { GatewayConfig } from "../config.js";
import { configInvalid } from "../errors/to-tool-error.js";
import type { Ranker } from "./ranker.js";
import { OramaKeywordRanker } from "./orama-keyword.js";
import { OramaVectorRanker } from "./orama-vector.js";
import { embedderFromConfig, type Embedder, type EmbeddingConfig } from "./embedder.js";
import { EmbeddingCache } from "./embedding-cache.js";

/** Test/DI seam: inject a fake {@link Embedder} so factory tests stay offline. */
export interface RankerFactoryDeps {
  embedder?: Embedder;
}

/**
 * @param cfg - the `search` section of {@link GatewayConfig}.
 * @param deps - optional injected embedder (tests); production builds it from cfg.
 * @throws {@link GatewayError} (`config_invalid`) for semantic/hybrid without an
 *   `embedding` sub-config, or an unknown ranker value.
 */
export function rankerFromConfig(cfg: GatewayConfig["search"], deps: RankerFactoryDeps = {}): Ranker {
  switch (cfg.ranker) {
    case "keyword":
      return new OramaKeywordRanker();
    case "semantic":
    case "hybrid": {
      const embeddingCfg = resolveEmbeddingConfig(cfg);
      const embedder = deps.embedder ?? embedderFromConfig(embeddingCfg);
      const cache = new EmbeddingCache(embeddingCfg.cacheDir);
      return new OramaVectorRanker(cfg.ranker, embedder, cache, embeddingCfg.dimensions);
    }
    default:
      throw configInvalid(`unknown ranker "${cfg.ranker as string}" (expected: keyword | semantic | hybrid)`);
  }
}

/**
 * The `embedding` sub-config is optional in the schema, but semantic/hybrid
 * require it (they have nothing to embed with otherwise). Fail loud with a clear
 * remediation rather than a downstream `undefined`.
 */
function resolveEmbeddingConfig(cfg: GatewayConfig["search"]): EmbeddingConfig {
  if (cfg.embedding === undefined) {
    throw configInvalid(
      `ranker "${cfg.ranker}" requires a search.embedding sub-config (backend + dimensions)`,
    );
  }
  return cfg.embedding;
}
