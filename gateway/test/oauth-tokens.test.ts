/**
 * T1 — OAuthTokensSchema + OAuthTokenResponseSchema
 *
 * Tests that:
 *   - OAuthTokensSchema accepts the full SDK-compatible shape (required + optional fields)
 *   - OAuthTokensSchema rejects objects missing the required `accessToken` field
 *   - OAuthTokenResponseSchema accepts the snake_case wire shape with optional refresh_token
 *   - OAuthTokenResponseSchema rejects missing required fields
 *
 * Imports from `src/secrets/oauth-tokens.ts` which does not exist yet (RED phase).
 */
import { describe, it, expect } from "vitest";
import { OAuthTokensSchema, OAuthTokenResponseSchema } from "../src/secrets/oauth-tokens.js";

const VALID_TOKENS = {
  provider: "linear",
  accessToken: "eyJhbGciOiJSUzI1NiJ9.test-access-token",
  expiresAt: Date.now() + 3_600_000,
  scopes: ["read", "write", "issues:create"],
  createdAt: Date.now(),
};

describe("OAuthTokensSchema", () => {
  it("accepts a minimal valid token record (no optional fields)", () => {
    const result = OAuthTokensSchema.safeParse(VALID_TOKENS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("linear");
      expect(result.data.accessToken).toBe(VALID_TOKENS.accessToken);
      expect(result.data.expiresAt).toBe(VALID_TOKENS.expiresAt);
      expect(result.data.scopes).toEqual(["read", "write", "issues:create"]);
      expect(result.data.createdAt).toBe(VALID_TOKENS.createdAt);
    }
  });

  it("accepts optional refreshToken field when present", () => {
    const withRefresh = { ...VALID_TOKENS, refreshToken: "rt-abc123" };
    const result = OAuthTokensSchema.safeParse(withRefresh);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.refreshToken).toBe("rt-abc123");
    }
  });

  it("accepts optional lastRefreshedAt field when present", () => {
    const withLastRefresh = { ...VALID_TOKENS, lastRefreshedAt: Date.now() - 1_000 };
    const result = OAuthTokensSchema.safeParse(withLastRefresh);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lastRefreshedAt).toBeDefined();
    }
  });

  it("accepts all optional fields together (full SDK shape)", () => {
    const full = {
      ...VALID_TOKENS,
      refreshToken: "rt-full",
      lastRefreshedAt: Date.now() - 500,
    };
    const result = OAuthTokensSchema.safeParse(full);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.refreshToken).toBe("rt-full");
      expect(result.data.lastRefreshedAt).toBeDefined();
    }
  });

  it("rejects a record missing accessToken", () => {
    const { accessToken: _, ...noAccess } = VALID_TOKENS;
    const result = OAuthTokensSchema.safeParse(noAccess);
    expect(result.success).toBe(false);
  });

  it("rejects a record missing provider", () => {
    const { provider: _, ...noProvider } = VALID_TOKENS;
    const result = OAuthTokensSchema.safeParse(noProvider);
    expect(result.success).toBe(false);
  });

  it("rejects a record missing expiresAt", () => {
    const { expiresAt: _, ...noExpiry } = VALID_TOKENS;
    const result = OAuthTokensSchema.safeParse(noExpiry);
    expect(result.success).toBe(false);
  });

  it("rejects a record missing scopes", () => {
    const { scopes: _, ...noScopes } = VALID_TOKENS;
    const result = OAuthTokensSchema.safeParse(noScopes);
    expect(result.success).toBe(false);
  });

  it("rejects a record missing createdAt", () => {
    const { createdAt: _, ...noCreated } = VALID_TOKENS;
    const result = OAuthTokensSchema.safeParse(noCreated);
    expect(result.success).toBe(false);
  });

  it("omits optional fields gracefully (undefined is the default)", () => {
    const result = OAuthTokensSchema.safeParse(VALID_TOKENS);
    expect(result.success).toBe(true);
    if (result.success) {
      // refreshToken and lastRefreshedAt should be undefined when not provided
      expect(result.data.refreshToken).toBeUndefined();
      expect(result.data.lastRefreshedAt).toBeUndefined();
    }
  });
});

describe("OAuthTokenResponseSchema", () => {
  it("accepts a minimal wire response (no refresh_token)", () => {
    const wire = { access_token: "new-at-xyz", expires_in: 3600 };
    const result = OAuthTokenResponseSchema.safeParse(wire);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.access_token).toBe("new-at-xyz");
      expect(result.data.expires_in).toBe(3600);
    }
  });

  it("accepts a wire response with optional refresh_token", () => {
    const wire = { access_token: "at-abc", refresh_token: "rt-new", expires_in: 86400 };
    const result = OAuthTokenResponseSchema.safeParse(wire);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.refresh_token).toBe("rt-new");
    }
  });

  it("rejects a wire response missing access_token", () => {
    const result = OAuthTokenResponseSchema.safeParse({ expires_in: 3600 });
    expect(result.success).toBe(false);
  });

  it("rejects a wire response missing expires_in", () => {
    const result = OAuthTokenResponseSchema.safeParse({ access_token: "tok" });
    expect(result.success).toBe(false);
  });

  it("has undefined refresh_token when not provided", () => {
    const result = OAuthTokenResponseSchema.safeParse({ access_token: "tok", expires_in: 3600 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.refresh_token).toBeUndefined();
    }
  });
});
