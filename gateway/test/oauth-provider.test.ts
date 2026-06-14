/**
 * T4 — OAuthSecretProvider (plan §2 C8, §5)
 *
 * Tests that:
 *   - resolve(["LINEAR_API_KEY"]) returns { LINEAR_API_KEY: "Bearer <access>" }
 *     (exact "Bearer " prefix from the `header` template "{token}" substitution)
 *   - manager.getValidAccessToken() returns null → throws GatewayError with code
 *     "missing_secret", naming only the key (not the token/body)
 *   - manager throws (refresh fail) → OAuthSecretProvider catches and rethrows as
 *     GatewayError with code "secret_backend_unavailable", naming only the key
 *     (NOT the token or body text — secret hygiene)
 *
 * OAuthManager is mocked via an injected bindings object that provides a
 * `managerFor()` factory returning a fake. No real network, no real store.
 *
 * Imports from `src/secrets/oauth-provider.ts` which does not exist yet (RED phase).
 */
import { describe, it, expect, vi } from "vitest";
import { OAuthSecretProvider } from "../src/secrets/oauth-provider.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

// ── fake manager factory ───────────────────────────────────────────────────────

/** Create a fake OAuthManager-shaped object with a stubbed getValidAccessToken. */
function fakeManager(getValidAccessToken: () => Promise<string | null>) {
  return { getValidAccessToken };
}

/** Build a bindings map for OAuthSecretProvider with one entry. */
function makeBindings(
  flatKey: string,
  getValidAccessToken: () => Promise<string | null>,
  header = "Bearer {token}",
) {
  return {
    [flatKey]: {
      managerFor: () => fakeManager(getValidAccessToken),
      header,
    },
  };
}

// ── happy path: Bearer prefix ──────────────────────────────────────────────────

describe("OAuthSecretProvider — header-ready Bearer output", () => {
  it("resolve(['LINEAR_API_KEY']) returns { LINEAR_API_KEY: 'Bearer <access>' }", async () => {
    const bindings = makeBindings(
      "LINEAR_API_KEY",
      async () => "eyJhbGciOiJSUzI1NiJ9.test-access-token",
    );
    const provider = new OAuthSecretProvider({ bindings });
    const result = await provider.resolve(["LINEAR_API_KEY"]);
    expect(result).toEqual({
      LINEAR_API_KEY: "Bearer eyJhbGciOiJSUzI1NiJ9.test-access-token",
    });
  });

  it("result has exact 'Bearer ' prefix (7 chars, capital B, space)", async () => {
    const bindings = makeBindings("MY_KEY", async () => "tok123");
    const provider = new OAuthSecretProvider({ bindings });
    const result = await provider.resolve(["MY_KEY"]);
    expect(result.MY_KEY).toMatch(/^Bearer /);
    expect(result.MY_KEY.substring(0, 7)).toBe("Bearer ");
  });

  it("resolves multiple keys independently", async () => {
    const bindings = {
      KEY_A: {
        managerFor: () => fakeManager(async () => "at-a"),
        header: "Bearer {token}",
      },
      KEY_B: {
        managerFor: () => fakeManager(async () => "at-b"),
        header: "Bearer {token}",
      },
    };
    const provider = new OAuthSecretProvider({ bindings });
    const result = await provider.resolve(["KEY_A", "KEY_B"]);
    expect(result).toEqual({
      KEY_A: "Bearer at-a",
      KEY_B: "Bearer at-b",
    });
  });

  it("header template {token} is substituted with the actual access token", async () => {
    const bindings = makeBindings("MY_KEY", async () => "my-secret-token");
    const provider = new OAuthSecretProvider({ bindings });
    const result = await provider.resolve(["MY_KEY"]);
    expect(result.MY_KEY).toBe("Bearer my-secret-token");
  });

  it("empty keys list returns empty record", async () => {
    const provider = new OAuthSecretProvider({ bindings: {} });
    const result = await provider.resolve([]);
    expect(result).toEqual({});
  });
});

// ── missing_secret: null from manager ─────────────────────────────────────────

describe("OAuthSecretProvider — null from manager → missing_secret", () => {
  it("throws GatewayError with code 'missing_secret' when getValidAccessToken returns null", async () => {
    const bindings = makeBindings("LINEAR_API_KEY", async () => null);
    const provider = new OAuthSecretProvider({ bindings });

    try {
      await provider.resolve(["LINEAR_API_KEY"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("missing_secret");
    }
  });

  it("missing_secret error message names the flat key", async () => {
    const bindings = makeBindings("LINEAR_API_KEY", async () => null);
    const provider = new OAuthSecretProvider({ bindings });

    try {
      await provider.resolve(["LINEAR_API_KEY"]);
      expect.fail("should have thrown a GatewayError");
    } catch (e) {
      expect((e as GatewayError).message).toContain("LINEAR_API_KEY");
    }
  });

  it("missing_secret error message does NOT contain a token or body value", async () => {
    const SECRET = "DO_NOT_LEAK_TOKEN";
    const bindings = makeBindings("LINEAR_API_KEY", async () => null);
    const provider = new OAuthSecretProvider({ bindings });

    try {
      await provider.resolve(["LINEAR_API_KEY"]);
      expect.fail("should have thrown a GatewayError");
    } catch (e) {
      expect((e as GatewayError).message).not.toContain(SECRET);
    }
  });
});

// ── secret_backend_unavailable: thrown from manager ───────────────────────────

describe("OAuthSecretProvider — manager throws → secret_backend_unavailable", () => {
  it("throws GatewayError with code 'secret_backend_unavailable' when manager throws", async () => {
    const bindings = makeBindings("LINEAR_API_KEY", async () => {
      throw new Error("HTTP 401: token refresh failed");
    });
    const provider = new OAuthSecretProvider({ bindings });

    try {
      await provider.resolve(["LINEAR_API_KEY"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("secret_backend_unavailable");
    }
  });

  it("secret_backend_unavailable message names the flat key", async () => {
    const bindings = makeBindings("LINEAR_API_KEY", async () => {
      throw new Error("refresh failed");
    });
    const provider = new OAuthSecretProvider({ bindings });

    try {
      await provider.resolve(["LINEAR_API_KEY"]);
      expect.fail("should have thrown a GatewayError");
    } catch (e) {
      expect((e as GatewayError).message).toContain("LINEAR_API_KEY");
    }
  });

  it("secret_backend_unavailable message does NOT expose the token or response body (secret hygiene)", async () => {
    const SECRET_BODY = "SECRET_TOKEN_RESPONSE_DO_NOT_LEAK";
    const bindings = makeBindings("LINEAR_API_KEY", async () => {
      // Simulate a leak attempt: error message with secret body
      throw new Error(`HTTP 400 error: ${SECRET_BODY}`);
    });
    const provider = new OAuthSecretProvider({ bindings });

    try {
      await provider.resolve(["LINEAR_API_KEY"]);
      expect.fail("should have thrown a GatewayError");
    } catch (e) {
      // The provider must NOT propagate the inner error message (which might contain secrets)
      expect((e as GatewayError).message).not.toContain(SECRET_BODY);
    }
  });

  it("re-wraps thrown GatewayError as secret_backend_unavailable (not double-wrapped)", async () => {
    // When the manager itself throws a GatewayError (e.g. from refreshAccessToken),
    // the provider should still produce secret_backend_unavailable
    const { GatewayError: GE } = await import("../src/errors/to-tool-error.js");
    const bindings = makeBindings("LINEAR_API_KEY", async () => {
      throw new GE("secret_backend_unavailable", "inner backend error");
    });
    const provider = new OAuthSecretProvider({ bindings });

    try {
      await provider.resolve(["LINEAR_API_KEY"]);
      expect.fail("should have thrown a GatewayError");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("secret_backend_unavailable");
    }
  });
});
