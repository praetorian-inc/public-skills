/**
 * Build a {@link SecretProvider} from the resolved `secrets` config.
 *
 * `env` (P0 default) reads `process.env`; `1password` (WS-2) shells out to the
 * 1Password `op` CLI. An unknown provider fails loudly with `config_invalid`
 * rather than silently falling back to env. Mirrors `rankerFromConfig`.
 */
import type { GatewayConfig } from "../config.js";
import { configInvalid } from "../errors/to-tool-error.js";
import type { SecretProvider } from "./provider.js";
import { EnvProvider } from "./env-provider.js";
import { OnePasswordProvider } from "./onepassword-provider.js";

/**
 * @param cfg - the `secrets` section of {@link GatewayConfig}.
 * @throws {@link GatewayError} (`config_invalid`) for an unknown provider value.
 */
export function secretsFromConfig(cfg: GatewayConfig["secrets"]): SecretProvider {
  switch (cfg.provider) {
    case "env":
      return new EnvProvider();
    case "1password":
      // `onepassword` may be undefined (the sub-object is optional); the
      // provider applies its own defaults in that case.
      return new OnePasswordProvider(cfg.onepassword);
    default:
      throw configInvalid(`unknown secrets provider "${cfg.provider}" (expected: env, 1password)`);
  }
}
