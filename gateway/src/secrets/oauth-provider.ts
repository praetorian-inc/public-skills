/**
 * OAuth-strategy SecretProvider (plan §2 C8).
 *
 * For each requested flat key, resolves a usable access token via the bound
 * {@link OAuthManager} and returns the header-ready value
 * `header.replace("{token}", access)` (e.g. `"Bearer <access>"`), so the Linear
 * wrapper's `Authorization: ctx.secrets.LINEAR_API_KEY` line stays unchanged.
 *
 * Error mapping (plan §4):
 *   - `getValidAccessToken()` returns null (no tokens / no refresh) ⇒ `missing_secret`,
 *     naming ONLY the flat key.
 *   - `getValidAccessToken()` THROWS (refresh HTTP/network failure) ⇒ caught and
 *     rethrown as `secret_backend_unavailable`, naming ONLY the flat key — the inner
 *     error (which may carry a token/body) is never propagated (secret hygiene).
 */
import { missingSecret, secretBackendUnavailable } from "../errors/to-tool-error.js";
import type { SecretProvider } from "./provider.js";
import type { OAuthManager } from "./oauth-manager.js";

/** Binding for one flat key: how to build its manager + how to present the token. */
export interface OAuthBinding {
  /** Factory for the key's OAuth manager (built once per resolve by the dispatcher). */
  managerFor: () => OAuthManager;
  /** Header template; `{token}` is substituted with the resolved access token. */
  header: string;
}

export interface OAuthSecretProviderDeps {
  /** flatKey → binding, resolved from `secrets.auth` + `secrets.oauth` by the dispatcher. */
  bindings: Record<string, OAuthBinding>;
}

export class OAuthSecretProvider implements SecretProvider {
  private readonly bindings: Record<string, OAuthBinding>;

  constructor(deps: OAuthSecretProviderDeps) {
    this.bindings = deps.bindings;
  }

  async resolve(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const flatKey of keys) {
      const binding = this.bindings[flatKey];
      if (binding === undefined) {
        // The dispatcher only routes oauth-strategy keys here, but guard defensively.
        throw missingSecret(flatKey);
      }

      let access: string | null;
      try {
        access = await binding.managerFor().getValidAccessToken();
      } catch {
        // Inner error may carry a token/body — name ONLY the key.
        throw secretBackendUnavailable(`oauth refresh failed for ${flatKey}`);
      }

      if (access === null) {
        // No tokens on disk and no refresh available — needs `auth login`.
        throw missingSecret(flatKey);
      }

      out[flatKey] = binding.header.replace("{token}", access);
    }
    return out;
  }
}
