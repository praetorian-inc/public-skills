/**
 * Build a {@link SecretProvider} from the resolved `secrets` config.
 *
 * P0 implements only `env`. `1password` is a valid config value (it arrives in
 * P1) but is not implemented yet, so it fails loudly with `config_invalid`
 * rather than silently falling back to env. Mirrors `rankerFromConfig`.
 */
import type { GatewayConfig } from "../config.js";
import { configInvalid } from "../errors/to-tool-error.js";
import type { SecretProvider } from "./provider.js";
import { EnvProvider } from "./env-provider.js";

/**
 * @param cfg - the `secrets` section of {@link GatewayConfig}.
 * @throws {@link GatewayError} (`config_invalid`) for `1password` (P1, not
 *   implemented in P0) or an unknown provider value.
 */
export function secretsFromConfig(cfg: GatewayConfig["secrets"]): SecretProvider {
  switch (cfg.provider) {
    case "env":
      return new EnvProvider();
    case "1password":
      throw configInvalid(
        `secrets provider "1password" is not implemented in P0 (env only); arrives in P1`,
      );
    default:
      throw configInvalid(`unknown secrets provider "${cfg.provider}" (expected: env)`);
  }
}
