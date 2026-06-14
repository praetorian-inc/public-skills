/**
 * Gateway-local OAuth token manager (plan §2 C6).
 *
 * A pure, injectable mirror of the SDK `OAuthTokenManager`
 * (`tools/claude-tool-sdk/src/oauth-manager.ts:24-321`) — PKCE (S256), auth-URL
 * build, code exchange, rotating refresh, 5-min validity buffer, and
 * `getValidAccessToken()`. The gateway must NOT import `@praetorian/claude-tool-sdk`,
 * so the logic is re-implemented here over an injected {@link TokenStore} seam and
 * an injected `fetch`/clock (tests drive both without real network or HOME).
 *
 * Stricter hygiene than the SDK:
 *   - On a non-2xx token-endpoint response we throw an Error carrying ONLY the HTTP
 *     status — never the response body (the SDK echoes the body at oauth-manager.ts:215,255).
 *   - `getValidAccessToken()` does NOT swallow a refresh HTTP failure: it propagates
 *     (the OAuth provider C8 maps it to `secret_backend_unavailable`). It returns
 *     null only for "needs login" (no tokens, or expired with no refresh token).
 *   - All diagnostics go to `console.error` (stdout is the MCP framing channel).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  OAuthTokenResponseSchema,
  type OAuthTokens,
} from "./oauth-tokens.js";
import type { OAuthProviderConfig } from "./oauth-config.js";
import type { TokenStore } from "./token-store/token-store.js";

/** Refresh 5 minutes before expiry (mirror SDK `TOKEN_REFRESH_BUFFER_MS`). */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface OAuthManagerDeps {
  /** Storage seam — injected (tests use an in-memory fake / temp file store). */
  store: TokenStore;
  /** Injected for tests; defaults to the Node ≥ 20 global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected clock; defaults to `Date.now`. */
  now?: () => number;
  /** Resolved from `${PROVIDER}_CLIENT_ID` by the provider; overrides `cfg.clientId`. */
  clientIdOverride?: string;
}

export interface PKCEParams {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

export class OAuthManager {
  private readonly provider: string;
  private readonly cfg: OAuthProviderConfig;
  private readonly store: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly clientId: string;

  constructor(provider: string, cfg: OAuthProviderConfig, deps: OAuthManagerDeps) {
    this.provider = provider;
    this.cfg = cfg;
    this.store = deps.store;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.clientId = deps.clientIdOverride ?? cfg.clientId;
  }

  /**
   * Generate PKCE parameters (S256).
   *
   * - `codeVerifier` = 32 random bytes, base64url-encoded.
   * - `codeChallenge` = base64url(SHA-256(verifierBytes)).
   * - `state` = 16 random bytes, hex-encoded (32 hex chars).
   */
  generatePKCE(): PKCEParams {
    const verifierBytes = randomBytes(32);
    const codeVerifier = verifierBytes.toString("base64url");
    const codeChallenge = createHash("sha256").update(verifierBytes).digest("base64url");
    const state = randomBytes(16).toString("hex");
    return { codeVerifier, codeChallenge, state };
  }

  /** Build the authorization URL (response_type=code, S256, scopes space-joined). */
  buildAuthorizationUrl(pkce: PKCEParams): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.cfg.redirect,
      response_type: "code",
      scope: this.cfg.scopes.join(" "),
      state: pkce.state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${this.cfg.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens (grant_type=authorization_code).
   * Saves the result via the injected store and returns it.
   */
  async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<OAuthTokens> {
    const data = await this.postForm({
      grant_type: "authorization_code",
      client_id: this.clientId,
      code,
      redirect_uri: this.cfg.redirect,
      code_verifier: codeVerifier,
    });
    const issued = this.now();
    const tokens: OAuthTokens = {
      provider: this.provider,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: issued + data.expires_in * 1000,
      scopes: this.cfg.scopes,
      createdAt: issued,
    };
    await this.store.save(this.provider, tokens);
    return tokens;
  }

  /**
   * Refresh the access token (grant_type=refresh_token). Rotating: keeps the prior
   * refresh token when the response omits a new one. Sets `lastRefreshedAt`, saves.
   */
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const data = await this.postForm({
      grant_type: "refresh_token",
      client_id: this.clientId,
      refresh_token: refreshToken,
    });
    const issued = this.now();
    const tokens: OAuthTokens = {
      provider: this.provider,
      accessToken: data.access_token,
      // Rotating refresh: a new refresh token replaces the old, else keep the old.
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: issued + data.expires_in * 1000,
      scopes: this.cfg.scopes,
      createdAt: issued,
      lastRefreshedAt: issued,
    };
    await this.store.save(this.provider, tokens);
    return tokens;
  }

  /** True when the token is not within the 5-minute pre-expiry buffer. */
  isTokenValid(tokens: OAuthTokens): boolean {
    return this.now() < tokens.expiresAt - TOKEN_REFRESH_BUFFER_MS;
  }

  /**
   * Return a usable access token, refreshing if needed.
   *
   * - No tokens on disk ⇒ null (needs login).
   * - Valid tokens ⇒ the access token (no network).
   * - Expired with a refresh token ⇒ refresh, return the new access token.
   * - Expired with NO refresh token ⇒ null (needs login).
   *
   * Throws ONLY when a refresh HTTP call fails (non-2xx / network) — the caller
   * maps that to `secret_backend_unavailable`. The thrown message carries only the
   * HTTP status, never the response body.
   */
  async getValidAccessToken(): Promise<string | null> {
    const tokens = await this.store.load(this.provider);
    if (tokens === null) {
      return null;
    }
    if (this.isTokenValid(tokens)) {
      return tokens.accessToken;
    }
    if (tokens.refreshToken) {
      const refreshed = await this.refreshAccessToken(tokens.refreshToken);
      return refreshed.accessToken;
    }
    return null;
  }

  /**
   * POST a form-urlencoded body to the token endpoint and parse the response.
   * On a non-2xx response, throws with ONLY the HTTP status (secret hygiene — the
   * response body may carry token material).
   */
  private async postForm(fields: Record<string, string>) {
    const response = await this.fetchImpl(this.cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    if (!response.ok) {
      // Status only — never the body (it may contain a token or error detail).
      throw new Error(`token endpoint returned HTTP ${response.status}`);
    }
    const raw = await response.json();
    return OAuthTokenResponseSchema.parse(raw);
  }
}
