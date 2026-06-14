/**
 * Storage seam for OAuth tokens (plan §2 C2).
 *
 * The default implementation is the `~/.claude-oauth/<provider>.json` file store
 * ({@link "./claude-oauth-store".ClaudeOAuthStore}); a 1Password-backed impl is
 * additive later (design D2). Keeping the seam abstract means the OAuth manager
 * (Cycle 2) depends only on this interface, not on a concrete backend.
 */
import type { OAuthTokens } from "../oauth-tokens.js";

export interface TokenStore {
  /** Load tokens for `provider`; null when absent or unparseable. */
  load(provider: string): Promise<OAuthTokens | null>;
  /** Persist tokens for `provider` (0600 file / equivalent). */
  save(provider: string, tokens: OAuthTokens): Promise<void>;
  /** Remove tokens for `provider` (idempotent). */
  clear(provider: string): Promise<void>;
}
