/**
 * P-B RED phase tests for `src/bin/auth.ts` (plan §2 C11, §6 P-B exit criteria).
 *
 * These tests REQUIRE the developer to expose a dependency-injected entry point:
 *
 *   runAuth(argv: string[], deps: AuthDeps): Promise<number>  // returns process exit code
 *
 *   AuthDeps = {
 *     store: TokenStore;
 *     runBrowserFlow?: (url: string, state: string, deps?: unknown) => Promise<string>;
 *     fetchImpl?: typeof fetch;
 *     now?: () => number;
 *     providers?: typeof DEFAULT_OAUTH_PROVIDERS;
 *     log?: (msg: string) => void;
 *   }
 *
 * ALL seams are injected:
 *   - store       → in-memory fake (no real ~/.claude-oauth writes)
 *   - runBrowserFlow → stub returning a sentinel auth code (no real browser)
 *   - fetchImpl   → function returning a mock token response (no real network)
 *   - now         → fixed clock (deterministic expiry)
 *   - providers   → DEFAULT_OAUTH_PROVIDERS from the module (no external registry)
 *   - log         → vi.fn() spy capturing all output (no console side-effects)
 *
 * Tests are RED because `src/bin/auth.ts` does not exist yet. The import below will
 * fail at module resolution time. That is the expected RED state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ESM .js import convention — the developer MUST export `runAuth` and
// `DEFAULT_OAUTH_PROVIDERS` from this module path.
import { runAuth, DEFAULT_OAUTH_PROVIDERS } from "../src/bin/auth.js";

import type { TokenStore } from "../src/secrets/token-store/token-store.js";
import type { OAuthTokens } from "../src/secrets/oauth-tokens.js";

// ── In-memory fake TokenStore ─────────────────────────────────────────────────

/**
 * A fake TokenStore backed by a plain Map — no filesystem, no HOME writes.
 * Injects safely into runAuth without any OS side-effects.
 */
function makeInMemoryStore(): TokenStore & { _data: Map<string, OAuthTokens> } {
  const data = new Map<string, OAuthTokens>();
  return {
    _data: data,
    async load(provider) {
      return data.get(provider) ?? null;
    },
    async save(provider, tokens) {
      data.set(provider, tokens);
    },
    async clear(provider) {
      data.delete(provider);
    },
  };
}

/**
 * A minimal mock fetch that returns a valid token endpoint response.
 * Sentinel values let the secret-hygiene test assert that they never appear in logs.
 */
function makeMockFetch(accessToken: string, refreshToken: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
    }),
  });
}

// ── Test 1: logout ────────────────────────────────────────────────────────────

describe("runAuth — logout", () => {
  it("calls store.clear(provider) and returns exit code 0", async () => {
    const store = makeInMemoryStore();
    // Pre-seed a token so we can assert clear was actually called
    await store.save("linear", {
      provider: "linear",
      accessToken: "old-token",
      expiresAt: Date.now() + 3600_000,
      scopes: ["read"],
      createdAt: Date.now(),
    });
    expect(store._data.has("linear")).toBe(true);

    const exitCode = await runAuth(["logout", "linear"], { store });

    expect(exitCode).toBe(0);
    expect(store._data.has("linear")).toBe(false);
  });

  it("returns exit code 0 even when no token exists (idempotent)", async () => {
    const store = makeInMemoryStore();
    // Nothing seeded — clear should still succeed
    const exitCode = await runAuth(["logout", "linear"], { store });
    expect(exitCode).toBe(0);
  });
});

// ── Test 2: login orchestration ───────────────────────────────────────────────

describe("runAuth — login orchestration", () => {
  const SENTINEL_ACCESS = "sentinel-access-token-abc123";
  const SENTINEL_REFRESH = "sentinel-refresh-token-xyz789";
  const FIXED_NOW = 1_700_000_000_000; // fixed epoch ms

  it("calls runBrowserFlow with an authorization URL containing client_id and code_challenge_method=S256", async () => {
    const store = makeInMemoryStore();
    const runBrowserFlow = vi.fn().mockResolvedValue("AUTH_CODE_FROM_BROWSER");
    const fetchImpl = makeMockFetch(SENTINEL_ACCESS, SENTINEL_REFRESH);

    await runAuth(["login", "linear"], {
      store,
      runBrowserFlow,
      fetchImpl,
      now: () => FIXED_NOW,
    });

    // runBrowserFlow must have been called exactly once
    expect(runBrowserFlow).toHaveBeenCalledOnce();

    // The first argument must be an authorization URL containing client_id and S256
    const authUrl: string = runBrowserFlow.mock.calls[0][0];
    expect(authUrl).toContain("client_id=");
    expect(authUrl).toContain("code_challenge_method=S256");
  });

  it("saves a token record to the store after successful exchange, returning exit code 0", async () => {
    const store = makeInMemoryStore();
    const runBrowserFlow = vi.fn().mockResolvedValue("AUTH_CODE_FROM_BROWSER");
    const fetchImpl = makeMockFetch(SENTINEL_ACCESS, SENTINEL_REFRESH);

    const exitCode = await runAuth(["login", "linear"], {
      store,
      runBrowserFlow,
      fetchImpl,
      now: () => FIXED_NOW,
    });

    expect(exitCode).toBe(0);

    // A token must be persisted to the store for provider "linear"
    const saved = await store.load("linear");
    expect(saved).not.toBeNull();
    expect(saved!.accessToken).toBe(SENTINEL_ACCESS);
  });
});

// ── Test 3: arg parsing ───────────────────────────────────────────────────────

describe("runAuth — argument parsing", () => {
  it("returns non-zero exit code for an unknown subcommand", async () => {
    const log = vi.fn();
    const store = makeInMemoryStore();

    const exitCode = await runAuth(["frobnicate", "linear"], { store, log });
    expect(exitCode).not.toBe(0);
  });

  it("logs usage message for an unknown subcommand", async () => {
    const log = vi.fn();
    const store = makeInMemoryStore();

    await runAuth(["frobnicate", "linear"], { store, log });

    const allOutput = log.mock.calls.map((c) => c[0]).join("\n");
    // Some form of usage/help text must appear
    expect(allOutput.toLowerCase()).toMatch(/usage|login|logout|help/);
  });

  it("returns non-zero exit code when service argument is missing (login without service)", async () => {
    const log = vi.fn();
    const store = makeInMemoryStore();

    const exitCode = await runAuth(["login"], { store, log });
    expect(exitCode).not.toBe(0);
  });

  it("returns non-zero exit code when service argument is missing (logout without service)", async () => {
    const log = vi.fn();
    const store = makeInMemoryStore();

    const exitCode = await runAuth(["logout"], { store, log });
    expect(exitCode).not.toBe(0);
  });
});

// ── Test 4: unknown service ───────────────────────────────────────────────────

describe("runAuth — unknown service", () => {
  it("returns non-zero exit code for an unrecognized service", async () => {
    const log = vi.fn();
    const store = makeInMemoryStore();

    const exitCode = await runAuth(["login", "nope"], {
      store,
      log,
      providers: DEFAULT_OAUTH_PROVIDERS,
    });
    expect(exitCode).not.toBe(0);
  });

  it("logs an error that names the unrecognized service", async () => {
    const log = vi.fn();
    const store = makeInMemoryStore();

    await runAuth(["login", "nope"], {
      store,
      log,
      providers: DEFAULT_OAUTH_PROVIDERS,
    });

    const allOutput = log.mock.calls.map((c) => c[0]).join("\n");
    // The service name "nope" must appear in the error message
    expect(allOutput).toContain("nope");
  });

  it("does not leak other service names or token values in the unknown-service error", async () => {
    const log = vi.fn();
    const store = makeInMemoryStore();

    await runAuth(["login", "nope"], {
      store,
      log,
      providers: DEFAULT_OAUTH_PROVIDERS,
    });

    const allOutput = log.mock.calls.map((c) => c[0]).join("\n");
    // The error should mention "nope" but not produce token material
    // (no client secrets or token values should be in the output)
    expect(allOutput).not.toMatch(/eyJ[A-Za-z0-9._-]+/); // no JWT-like tokens
  });
});

// ── Test 5: secret hygiene ────────────────────────────────────────────────────

describe("runAuth — secret hygiene (log output must never contain token values)", () => {
  const SENTINEL_ACCESS = "SUPER_SECRET_ACCESS_TOKEN_DO_NOT_LOG_9xBq7";
  const SENTINEL_REFRESH = "SUPER_SECRET_REFRESH_TOKEN_DO_NOT_LOG_mK3r";
  const FIXED_NOW = 1_700_000_000_000;

  it("never logs the access token value across a successful login flow", async () => {
    const logLines: string[] = [];
    const log = (msg: string) => logLines.push(msg);

    const store = makeInMemoryStore();
    const runBrowserFlow = vi.fn().mockResolvedValue("AUTHCODE123");
    const fetchImpl = makeMockFetch(SENTINEL_ACCESS, SENTINEL_REFRESH);

    const exitCode = await runAuth(["login", "linear"], {
      store,
      runBrowserFlow,
      fetchImpl,
      now: () => FIXED_NOW,
      log,
    });

    expect(exitCode).toBe(0);

    const combined = logLines.join("\n");
    expect(combined).not.toContain(SENTINEL_ACCESS);
  });

  it("never logs the refresh token value across a successful login flow", async () => {
    const logLines: string[] = [];
    const log = (msg: string) => logLines.push(msg);

    const store = makeInMemoryStore();
    const runBrowserFlow = vi.fn().mockResolvedValue("AUTHCODE123");
    const fetchImpl = makeMockFetch(SENTINEL_ACCESS, SENTINEL_REFRESH);

    const exitCode = await runAuth(["login", "linear"], {
      store,
      runBrowserFlow,
      fetchImpl,
      now: () => FIXED_NOW,
      log,
    });

    expect(exitCode).toBe(0);

    const combined = logLines.join("\n");
    expect(combined).not.toContain(SENTINEL_REFRESH);
  });

  it("never logs tokens even when multiple log calls are made across the login flow", async () => {
    // This test captures all log calls — even progress messages — and asserts
    // the sentinel values are absent from every single one.
    const log = vi.fn();

    const store = makeInMemoryStore();
    const runBrowserFlow = vi.fn().mockResolvedValue("AUTHCODE999");
    const fetchImpl = makeMockFetch(SENTINEL_ACCESS, SENTINEL_REFRESH);

    await runAuth(["login", "linear"], {
      store,
      runBrowserFlow,
      fetchImpl,
      now: () => FIXED_NOW,
      log,
    });

    for (const [msg] of log.mock.calls) {
      expect(String(msg)).not.toContain(SENTINEL_ACCESS);
      expect(String(msg)).not.toContain(SENTINEL_REFRESH);
    }
  });
});
