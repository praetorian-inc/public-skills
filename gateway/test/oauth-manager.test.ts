/**
 * T3 — OAuthManager (plan §2 C6, §5)
 *
 * All deps are injected:
 *   - store   : a fake TokenStore (in-memory Map)
 *   - fetchImpl : a vi.fn() that returns mock responses
 *   - now     : an injected clock (() => number)
 *
 * No real network, no real HOME, no browser launch.
 *
 * Tests (from plan §5 unit matrix):
 *   - generatePKCE(): verifier decodes to 32 bytes; challenge = base64url(SHA-256(verifier));
 *     state = 32 hex chars (16 bytes).
 *   - buildAuthorizationUrl(pkce): has client_id, redirect_uri, response_type=code,
 *     scope space-joined, state, code_challenge, code_challenge_method=S256.
 *   - exchangeCodeForTokens: POST to tokenUrl form-encoded grant_type=authorization_code;
 *     mock returns {access_token, refresh_token, expires_in}; result expiresAt ≈ now +
 *     expires_in*1000; saved via injected store.
 *   - rotating refresh: response WITHOUT refresh_token keeps prior refreshToken; WITH one
 *     replaces it; lastRefreshedAt set.
 *   - isTokenValid: false when now > expiresAt - 5min; true otherwise.
 *   - getValidAccessToken paths: no tokens→null; valid→access (no fetch); expired+refresh
 *     →refreshed access; expired+no-refresh→null; refresh HTTP non-2xx→throws (secret
 *     hygiene: throws without the response body in the message).
 *
 * Imports from `src/secrets/oauth-manager.ts` which does not exist yet (RED phase).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OAuthManager as OAuthManagerType, OAuthManagerDeps } from "../src/secrets/oauth-manager.js";
import { OAuthManager } from "../src/secrets/oauth-manager.js";
import type { OAuthTokens } from "../src/secrets/oauth-tokens.js";
import type { TokenStore } from "../src/secrets/token-store/token-store.js";
import type { OAuthProviderConfig } from "../src/secrets/oauth-config.js";

// ── helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal, complete OAuthProviderConfig for testing. */
function makeConfig(overrides: Partial<OAuthProviderConfig> = {}): OAuthProviderConfig {
  return {
    authorizeUrl: "https://example.com/oauth/authorize",
    tokenUrl: "https://example.com/oauth/token",
    clientId: "test-client-id",
    pkce: true,
    scopes: ["read", "write"],
    actor: "user" as const,
    redirect: "http://localhost:14881/oauth/callback",
    header: "Bearer {token}",
    ...overrides,
  };
}

/** In-memory TokenStore for tests — no file I/O. */
function makeInMemoryStore(initial?: OAuthTokens): TokenStore & { saved: OAuthTokens | null } {
  let stored: OAuthTokens | null = initial ?? null;
  const store = {
    get saved() { return stored; },
    async load(_provider: string): Promise<OAuthTokens | null> {
      return stored;
    },
    async save(_provider: string, tokens: OAuthTokens): Promise<void> {
      stored = tokens;
    },
    async clear(_provider: string): Promise<void> {
      stored = null;
    },
  };
  return store;
}

/** Build a Response-like object for mock fetch. */
function mockFetchOk(body: object): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockFetchError(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: "server_error" }),
    text: async () => `Error ${status}: server error`,
  } as unknown as Response;
}

const BASE_TOKENS: OAuthTokens = {
  provider: "test-provider",
  accessToken: "at-initial",
  refreshToken: "rt-initial",
  expiresAt: Date.now() + 3_600_000, // 1h from now — valid
  scopes: ["read", "write"],
  createdAt: Date.now() - 60_000,
};

// 5-minute buffer in ms (mirrors TOKEN_REFRESH_BUFFER_MS in C6)
const FIVE_MIN_MS = 5 * 60 * 1000;

// ── generatePKCE ───────────────────────────────────────────────────────────────

describe("OAuthManager.generatePKCE()", () => {
  it("codeVerifier decodes from base64url to exactly 32 bytes", () => {
    const store = makeInMemoryStore();
    const mgr = new OAuthManager("test-provider", makeConfig(), { store });
    const { codeVerifier } = mgr.generatePKCE();

    // base64url decode: replace - with + and _ with /, add padding, decode
    const padded = codeVerifier.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(padded, "base64");
    expect(decoded.length).toBe(32);
  });

  it("codeChallenge equals base64url(SHA-256(codeVerifier))", async () => {
    const store = makeInMemoryStore();
    const mgr = new OAuthManager("test-provider", makeConfig(), { store });
    const { codeVerifier, codeChallenge } = mgr.generatePKCE();

    // Reproduce the SHA-256 challenge computation
    const { createHash } = await import("node:crypto");
    const verifierBuf = Buffer.from(
      codeVerifier.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    const hash = createHash("sha256").update(verifierBuf).digest();
    const expected = hash
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    expect(codeChallenge).toBe(expected);
  });

  it("state is 32 hex characters (16 bytes hex-encoded)", () => {
    const store = makeInMemoryStore();
    const mgr = new OAuthManager("test-provider", makeConfig(), { store });
    const { state } = mgr.generatePKCE();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates different PKCE params on each call", () => {
    const store = makeInMemoryStore();
    const mgr = new OAuthManager("test-provider", makeConfig(), { store });
    const first = mgr.generatePKCE();
    const second = mgr.generatePKCE();
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    expect(first.state).not.toBe(second.state);
  });
});

// ── buildAuthorizationUrl ──────────────────────────────────────────────────────

describe("OAuthManager.buildAuthorizationUrl(pkce)", () => {
  let mgr: OAuthManagerType;
  let pkce: ReturnType<OAuthManagerType["generatePKCE"]>;

  beforeEach(() => {
    const store = makeInMemoryStore();
    mgr = new OAuthManager("test-provider", makeConfig(), { store });
    pkce = mgr.generatePKCE();
  });

  it("URL contains the client_id", () => {
    const url = mgr.buildAuthorizationUrl(pkce);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
  });

  it("URL contains redirect_uri matching config", () => {
    const url = mgr.buildAuthorizationUrl(pkce);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:14881/oauth/callback");
  });

  it("URL has response_type=code", () => {
    const url = mgr.buildAuthorizationUrl(pkce);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("response_type")).toBe("code");
  });

  it("URL has scope as space-joined scopes", () => {
    const url = mgr.buildAuthorizationUrl(pkce);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("scope")).toBe("read write");
  });

  it("URL has the state from pkce", () => {
    const url = mgr.buildAuthorizationUrl(pkce);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("state")).toBe(pkce.state);
  });

  it("URL has the code_challenge from pkce", () => {
    const url = mgr.buildAuthorizationUrl(pkce);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge")).toBe(pkce.codeChallenge);
  });

  it("URL has code_challenge_method=S256", () => {
    const url = mgr.buildAuthorizationUrl(pkce);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("URL base matches the config authorizeUrl", () => {
    const url = mgr.buildAuthorizationUrl(pkce);
    const parsed = new URL(url);
    expect(`${parsed.protocol}//${parsed.host}${parsed.pathname}`).toBe(
      "https://example.com/oauth/authorize",
    );
  });

  it("URL contains all required params (none missing)", () => {
    const url = mgr.buildAuthorizationUrl(pkce);
    const parsed = new URL(url);
    const required = [
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
    ];
    for (const param of required) {
      expect(parsed.searchParams.has(param), `missing param: ${param}`).toBe(true);
    }
  });
});

// ── exchangeCodeForTokens ──────────────────────────────────────────────────────

describe("OAuthManager.exchangeCodeForTokens()", () => {
  it("POSTs form-encoded body to tokenUrl with grant_type=authorization_code", async () => {
    const store = makeInMemoryStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      mockFetchOk({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
    );
    const now = () => 1_000_000;
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl, now });

    await mgr.exchangeCodeForTokens("auth-code-123", "verifier-abc");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/oauth/token");

    // Content-Type must be application/x-www-form-urlencoded
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    // Body must be form-encoded and contain grant_type=authorization_code
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-123");
    expect(body.get("code_verifier")).toBe("verifier-abc");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("redirect_uri")).toBe("http://localhost:14881/oauth/callback");
  });

  it("result expiresAt equals now() + expires_in * 1000", async () => {
    const nowMs = 2_000_000;
    const store = makeInMemoryStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      mockFetchOk({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
    );
    const now = () => nowMs;
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl, now });

    const tokens = await mgr.exchangeCodeForTokens("code", "verifier");
    expect(tokens.expiresAt).toBe(nowMs + 3600 * 1000);
  });

  it("saves the tokens to the injected store after exchange", async () => {
    const store = makeInMemoryStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      mockFetchOk({ access_token: "saved-at", refresh_token: "saved-rt", expires_in: 3600 }),
    );
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl });

    await mgr.exchangeCodeForTokens("code", "verifier");
    expect(store.saved).not.toBeNull();
    expect(store.saved?.accessToken).toBe("saved-at");
    expect(store.saved?.refreshToken).toBe("saved-rt");
  });

  it("returned tokens have the correct provider name", async () => {
    const store = makeInMemoryStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      mockFetchOk({ access_token: "at", expires_in: 3600 }),
    );
    const mgr = new OAuthManager("my-provider", makeConfig(), { store, fetchImpl });
    const tokens = await mgr.exchangeCodeForTokens("code", "verifier");
    expect(tokens.provider).toBe("my-provider");
  });

  it("returned tokens have the scopes from config", async () => {
    const store = makeInMemoryStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      mockFetchOk({ access_token: "at", expires_in: 3600 }),
    );
    const mgr = new OAuthManager("p", makeConfig({ scopes: ["read", "write", "issues:create"] }), { store, fetchImpl });
    const tokens = await mgr.exchangeCodeForTokens("code", "verifier");
    expect(tokens.scopes).toEqual(["read", "write", "issues:create"]);
  });
});

// ── rotating refresh ───────────────────────────────────────────────────────────

describe("OAuthManager.refreshAccessToken() — rotating refresh", () => {
  it("refresh response WITHOUT refresh_token keeps the prior refreshToken", async () => {
    const store = makeInMemoryStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      // No refresh_token in response
      mockFetchOk({ access_token: "new-at", expires_in: 3600 }),
    );
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl });

    const tokens = await mgr.refreshAccessToken("old-rt");
    // rotating: new refresh absent → keep old
    expect(tokens.refreshToken).toBe("old-rt");
  });

  it("refresh response WITH a new refresh_token replaces the prior one", async () => {
    const store = makeInMemoryStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      mockFetchOk({ access_token: "new-at", refresh_token: "brand-new-rt", expires_in: 3600 }),
    );
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl });

    const tokens = await mgr.refreshAccessToken("old-rt");
    expect(tokens.refreshToken).toBe("brand-new-rt");
  });

  it("sets lastRefreshedAt to now() after a refresh", async () => {
    const nowMs = 9_000_000;
    const store = makeInMemoryStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      mockFetchOk({ access_token: "at", expires_in: 3600 }),
    );
    const now = () => nowMs;
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl, now });

    const tokens = await mgr.refreshAccessToken("rt");
    expect(tokens.lastRefreshedAt).toBe(nowMs);
  });

  it("saves the refreshed tokens to the store", async () => {
    const store = makeInMemoryStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      mockFetchOk({ access_token: "refreshed-at", refresh_token: "new-rt", expires_in: 3600 }),
    );
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl });

    await mgr.refreshAccessToken("old-rt");
    expect(store.saved?.accessToken).toBe("refreshed-at");
  });
});

// ── isTokenValid ───────────────────────────────────────────────────────────────

describe("OAuthManager.isTokenValid(tokens)", () => {
  it("returns true when now() < expiresAt - 5min buffer", () => {
    const store = makeInMemoryStore();
    const nowMs = 1_000_000;
    // expiresAt is 10 min from now — well within the buffer
    const tokens: OAuthTokens = {
      ...BASE_TOKENS,
      expiresAt: nowMs + 10 * 60 * 1000,
    };
    const mgr = new OAuthManager("p", makeConfig(), { store, now: () => nowMs });
    expect(mgr.isTokenValid(tokens)).toBe(true);
  });

  it("returns false when now() == expiresAt - 5min exactly (boundary)", () => {
    const store = makeInMemoryStore();
    const nowMs = 1_000_000;
    const tokens: OAuthTokens = {
      ...BASE_TOKENS,
      expiresAt: nowMs + FIVE_MIN_MS, // exactly at buffer boundary
    };
    const mgr = new OAuthManager("p", makeConfig(), { store, now: () => nowMs });
    // now >= expiresAt - buffer → false
    expect(mgr.isTokenValid(tokens)).toBe(false);
  });

  it("returns false when now() > expiresAt - 5min (expired within buffer)", () => {
    const store = makeInMemoryStore();
    const nowMs = 1_000_000;
    const tokens: OAuthTokens = {
      ...BASE_TOKENS,
      expiresAt: nowMs + FIVE_MIN_MS - 1, // 1ms inside buffer
    };
    const mgr = new OAuthManager("p", makeConfig(), { store, now: () => nowMs });
    expect(mgr.isTokenValid(tokens)).toBe(false);
  });

  it("returns false when token is fully expired (expiresAt in the past)", () => {
    const store = makeInMemoryStore();
    const nowMs = 1_000_000;
    const tokens: OAuthTokens = {
      ...BASE_TOKENS,
      expiresAt: nowMs - 1000, // already expired
    };
    const mgr = new OAuthManager("p", makeConfig(), { store, now: () => nowMs });
    expect(mgr.isTokenValid(tokens)).toBe(false);
  });
});

// ── getValidAccessToken paths ──────────────────────────────────────────────────

describe("OAuthManager.getValidAccessToken()", () => {
  it("returns null when no tokens are stored (no tokens → null)", async () => {
    const store = makeInMemoryStore(); // starts empty
    const fetchImpl = vi.fn();
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl });

    const result = await mgr.getValidAccessToken();
    expect(result).toBeNull();
    // No network call should be made
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns access token directly when tokens are valid (no fetch call)", async () => {
    const nowMs = 1_000_000;
    // Valid: expiresAt is 1h from now
    const validTokens: OAuthTokens = {
      ...BASE_TOKENS,
      expiresAt: nowMs + 3_600_000,
      accessToken: "valid-at",
    };
    const store = makeInMemoryStore(validTokens);
    const fetchImpl = vi.fn();
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl, now: () => nowMs });

    const result = await mgr.getValidAccessToken();
    expect(result).toBe("valid-at");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes and returns new access token when tokens are expired + have a refreshToken", async () => {
    const nowMs = 5_000_000;
    // Expired: expiresAt is in the past
    const expiredTokens: OAuthTokens = {
      ...BASE_TOKENS,
      expiresAt: nowMs - 1000,
      accessToken: "old-at",
      refreshToken: "valid-rt",
    };
    const store = makeInMemoryStore(expiredTokens);
    const fetchImpl = vi.fn().mockResolvedValue(
      mockFetchOk({ access_token: "refreshed-at", expires_in: 3600 }),
    );
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl, now: () => nowMs });

    const result = await mgr.getValidAccessToken();
    expect(result).toBe("refreshed-at");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns null when tokens are expired and have no refreshToken", async () => {
    const nowMs = 5_000_000;
    const expiredNoRefresh: OAuthTokens = {
      ...BASE_TOKENS,
      expiresAt: nowMs - 1000,
      accessToken: "old-at",
      refreshToken: undefined,
    };
    const store = makeInMemoryStore(expiredNoRefresh);
    const fetchImpl = vi.fn();
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl, now: () => nowMs });

    const result = await mgr.getValidAccessToken();
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when refresh HTTP returns non-2xx (propagates the error)", async () => {
    const nowMs = 5_000_000;
    const expiredTokens: OAuthTokens = {
      ...BASE_TOKENS,
      expiresAt: nowMs - 1000,
      accessToken: "old-at",
      refreshToken: "rt",
    };
    const store = makeInMemoryStore(expiredTokens);
    const fetchImpl = vi.fn().mockResolvedValue(mockFetchError(401));
    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl, now: () => nowMs });

    await expect(mgr.getValidAccessToken()).rejects.toThrow();
  });

  it("thrown refresh error does NOT contain the response body (secret hygiene)", async () => {
    const nowMs = 5_000_000;
    const SECRET_IN_BODY = "SECRET_TOKEN_DO_NOT_LEAK";
    const expiredTokens: OAuthTokens = {
      ...BASE_TOKENS,
      expiresAt: nowMs - 1000,
      accessToken: "old-at",
      refreshToken: "rt",
    };
    const store = makeInMemoryStore(expiredTokens);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => `error: ${SECRET_IN_BODY}`,
      json: async () => ({ error: SECRET_IN_BODY }),
    } as unknown as Response);

    const mgr = new OAuthManager("test-provider", makeConfig(), { store, fetchImpl, now: () => nowMs });

    try {
      await mgr.getValidAccessToken();
      throw new Error("expected to throw");
    } catch (e) {
      const msg = (e as Error).message;
      // Must contain HTTP status but NOT the response body content
      expect(msg).not.toContain(SECRET_IN_BODY);
    }
  });
});
