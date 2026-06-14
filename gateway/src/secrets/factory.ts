/**
 * Build a {@link SecretProvider} from the resolved `secrets` config.
 *
 * `env` (P0 default) reads `process.env`; `1password` (WS-2) shells out to the
 * 1Password `op` CLI. An unknown provider fails loudly with `config_invalid`
 * rather than silently falling back to env.
 *
 * M2 (OAuth): the global provider above is the per-key default. When `secrets.auth`
 * is present, the global provider is WRAPPED in a {@link DispatchingSecretProvider}
 * that peels off the `oauth`-strategy keys and routes them to an
 * {@link OAuthSecretProvider}; everything else still reaches the global provider
 * with exactly the keys it handled before (byte-for-byte back-compat). With no
 * `secrets.auth`, the bare global provider is returned (the 410 existing tests
 * describe its behavior verbatim).
 */
import type { GatewayConfig } from "../config.js";
import { configInvalid } from "../errors/to-tool-error.js";
import type { SecretProvider } from "./provider.js";
import { EnvProvider } from "./env-provider.js";
import { OnePasswordProvider } from "./onepassword-provider.js";
import { DispatchingSecretProvider } from "./dispatching-provider.js";
import { OAuthSecretProvider, type OAuthBinding } from "./oauth-provider.js";
import { OAuthManager } from "./oauth-manager.js";
import { ClaudeOAuthStore } from "./token-store/claude-oauth-store.js";
import { OnePasswordTokenStore } from "./token-store/onepassword-store.js";
import type { TokenStore } from "./token-store/token-store.js";
import type { OAuthProviderConfig } from "./oauth-config.js";

type SecretsConfig = GatewayConfig["secrets"];

/**
 * Build the global (env / 1password) provider — the existing `switch` body,
 * unchanged. This is the per-key default for any flat key not declared `oauth`.
 *
 * @throws {@link GatewayError} (`config_invalid`) for an unknown provider value.
 */
function buildGlobalProvider(cfg: SecretsConfig): SecretProvider {
  switch (cfg.provider) {
    case "env":
      return new EnvProvider();
    case "1password":
      // `onepassword` may be undefined (the sub-object is optional); the provider
      // applies its own defaults. When present it carries the enriched
      // service-aware shape straight through.
      return new OnePasswordProvider(cfg.onepassword);
    default:
      throw configInvalid(`unknown secrets provider "${cfg.provider}" (expected: env, 1password)`);
  }
}

/**
 * Build the {@link OAuthSecretProvider} from `secrets.auth` (oauth rows) +
 * `secrets.oauth` (the provider registry). One {@link OAuthManager} is constructed
 * per distinct oauth provider name and shared across the flat keys that reference
 * it; the per-key binding records the provider's `header` template. A
 * `${PROVIDER}_CLIENT_ID` env var (e.g. `LINEAR_CLIENT_ID`) overrides the committed
 * public client id (config stays declarative — matches the OP_* precedent).
 */
function buildOAuthProvider(cfg: SecretsConfig): SecretProvider {
  const authMap = cfg.auth ?? {};
  const registry: Record<string, OAuthProviderConfig> = cfg.oauth ?? {};
  // Cache one manager per (provider name + store kind) so distinct keys sharing a
  // provider/store reuse the same manager + store instance.
  const managerCache = new Map<string, OAuthManager>();
  const bindings: Record<string, OAuthBinding> = {};

  for (const [flatKey, row] of Object.entries(authMap)) {
    if (row.type !== "oauth") continue;

    const providerName = row.provider;
    if (!providerName) {
      throw configInvalid(`secrets.auth.${flatKey}.provider is required when type is "oauth"`);
    }
    const providerCfg = registry[providerName];
    if (providerCfg === undefined) {
      throw configInvalid(
        `secrets.auth.${flatKey}.provider "${providerName}" is not defined in secrets.oauth`,
      );
    }

    const storeKind = row.store ?? "claude-oauth";
    const cacheKey = `${providerName}::${storeKind}`;
    let manager = managerCache.get(cacheKey);
    if (manager === undefined) {
      const store: TokenStore =
        storeKind === "1password" ? new OnePasswordTokenStore() : new ClaudeOAuthStore();
      // Env override: ${PROVIDER}_CLIENT_ID (e.g. LINEAR_CLIENT_ID).
      const envVar = `${providerName.toUpperCase()}_CLIENT_ID`;
      const override = process.env[envVar];
      const clientIdOverride =
        override !== undefined && override !== "" ? override : undefined;
      manager = new OAuthManager(providerName, providerCfg, { store, clientIdOverride });
      managerCache.set(cacheKey, manager);
    }

    const boundManager = manager;
    bindings[flatKey] = {
      managerFor: () => boundManager,
      header: providerCfg.header,
    };
  }

  return new OAuthSecretProvider({ bindings });
}

/**
 * @param cfg - the `secrets` section of {@link GatewayConfig}.
 * @throws {@link GatewayError} (`config_invalid`) for an unknown provider value.
 */
export function secretsFromConfig(cfg: SecretsConfig): SecretProvider {
  const global = buildGlobalProvider(cfg);
  // BACK-COMPAT: no auth map ⇒ the bare global provider (env/1password unchanged).
  if (cfg.auth === undefined || Object.keys(cfg.auth).length === 0) {
    return global;
  }
  const oauth = buildOAuthProvider(cfg);
  return new DispatchingSecretProvider({
    globalProvider: global,
    oauthProvider: oauth,
    authMap: cfg.auth,
    globalProviderKind: cfg.provider,
  });
}
