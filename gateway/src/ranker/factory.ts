/**
 * Build a {@link Ranker} from the resolved `search` config.
 *
 * P0 implements only `keyword`. `semantic` and `hybrid` are valid config values
 * (the same orama engine backs them in P1) but are not implemented yet, so they
 * fail loudly rather than silently falling back to keyword.
 */
import type { GatewayConfig } from "../config.js";
import { GatewayError } from "../errors/to-tool-error.js";
import type { Ranker } from "./ranker.js";
import { OramaKeywordRanker } from "./orama-keyword.js";

/**
 * @param cfg - the `search` section of {@link GatewayConfig}.
 * @throws {@link GatewayError} (`manifest_invalid`) for `semantic`/`hybrid`
 *   (P1, not implemented in P0) or an unknown ranker value.
 */
export function rankerFromConfig(cfg: GatewayConfig["search"]): Ranker {
  switch (cfg.ranker) {
    case "keyword":
      return new OramaKeywordRanker();
    case "semantic":
    case "hybrid":
      throw new GatewayError(
        "manifest_invalid",
        `ranker "${cfg.ranker}" is not implemented in P0 (keyword only); semantic/hybrid arrive in P1`,
      );
    default:
      throw new GatewayError(
        "manifest_invalid",
        `unknown ranker "${cfg.ranker}" (expected: keyword)`,
      );
  }
}
