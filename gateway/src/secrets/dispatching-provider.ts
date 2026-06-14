/**
 * Strategy-dispatching SecretProvider (plan §2 C10, §3, Risk 4).
 *
 * Wraps the existing global provider (env / 1password, unchanged) and the
 * {@link OAuthSecretProvider}. For each requested flat key it resolves the strategy
 * ({@link resolveStrategy}) and partitions the key into the oauth bucket or the
 * global bucket. Each delegate is then called with ONLY its subset of keys
 * (Risk 4: the global provider must never see an oauth key, or it would wrongly
 * report `missing_secret`), and the two records are merged (flat-key shape).
 *
 * Empty `keys` ⇒ `{}` invoking NO provider (the context7 keyless path is unaffected).
 */
import type { SecretProvider } from "./provider.js";
import {
  resolveStrategy,
  type AuthMap,
  type GlobalProviderKind,
} from "./auth-strategy.js";

export interface DispatchingProviderDeps {
  /** Existing EnvProvider | OnePasswordProvider (unchanged). */
  globalProvider: SecretProvider;
  /** OAuthSecretProvider (C8). */
  oauthProvider: SecretProvider;
  /** `secrets.auth` — absent/empty ⇒ every key routes to the global provider. */
  authMap?: AuthMap;
  /** The active `secrets.provider`, for default-strategy resolution. */
  globalProviderKind: GlobalProviderKind;
}

export class DispatchingSecretProvider implements SecretProvider {
  private readonly globalProvider: SecretProvider;
  private readonly oauthProvider: SecretProvider;
  private readonly authMap?: AuthMap;
  private readonly globalProviderKind: GlobalProviderKind;

  constructor(deps: DispatchingProviderDeps) {
    this.globalProvider = deps.globalProvider;
    this.oauthProvider = deps.oauthProvider;
    this.authMap = deps.authMap;
    this.globalProviderKind = deps.globalProviderKind;
  }

  async resolve(keys: string[]): Promise<Record<string, string>> {
    if (keys.length === 0) {
      // Keyless path — invoke neither delegate.
      return {};
    }

    const oauthKeys: string[] = [];
    const globalKeys: string[] = [];
    for (const key of keys) {
      const strat = resolveStrategy(key, this.authMap, this.globalProviderKind);
      if (strat.type === "oauth") {
        oauthKeys.push(key);
      } else {
        globalKeys.push(key);
      }
    }

    // Call each delegate ONLY with its subset (Risk 4). Skip a delegate entirely
    // when its bucket is empty so it is never invoked with [] (preserves the
    // "no provider called" expectation for single-strategy key sets).
    const globalRecord =
      globalKeys.length > 0 ? await this.globalProvider.resolve(globalKeys) : {};
    const oauthRecord =
      oauthKeys.length > 0 ? await this.oauthProvider.resolve(oauthKeys) : {};

    return { ...globalRecord, ...oauthRecord };
  }
}
