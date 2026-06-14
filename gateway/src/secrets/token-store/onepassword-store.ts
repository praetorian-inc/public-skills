/**
 * 1Password-backed OAuth token store (plan §2 C4, design D2 alternate).
 *
 * P-A SCOPE: conform to the {@link TokenStore} interface but throw
 * `secret_backend_unavailable` until the `op read`/`op write` path is wired, so
 * selecting `store: 1password` fails LOUD rather than silently returning no
 * credential. Read/write parity is deferred (P-B+ / out of P-A scope, §6/§7).
 *
 * Wiring this later does NOT change the {@link TokenStore} interface — the seam
 * was designed for it.
 */
import { secretBackendUnavailable } from "../../errors/to-tool-error.js";
import type { OAuthTokens } from "../oauth-tokens.js";
import type { TokenStore } from "./token-store.js";

const NOT_WIRED = "1Password token store not yet wired";

export class OnePasswordTokenStore implements TokenStore {
  async load(_provider: string): Promise<OAuthTokens | null> {
    throw secretBackendUnavailable(NOT_WIRED);
  }

  async save(_provider: string, _tokens: OAuthTokens): Promise<void> {
    throw secretBackendUnavailable(NOT_WIRED);
  }

  async clear(_provider: string): Promise<void> {
    throw secretBackendUnavailable(NOT_WIRED);
  }
}
