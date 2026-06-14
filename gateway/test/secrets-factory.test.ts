/**
 * secretsFromConfig coverage.
 *
 * Mirrors the rankerFromConfig block in keyword-ranker.test.ts:
 *   env       → returns an EnvProvider instance (P0 regression guard)
 *   1password → returns an OnePasswordProvider instance (WS-2; replaces the P0
 *               config_invalid throw)
 *   unknown   → throws GatewayError with code "config_invalid"
 *
 * T10 (back-compat, Cycle 2):
 *   provider: env  with NO auth key → EnvProvider (bare provider, unchanged)
 *   provider: 1password with NO auth key → OnePasswordProvider (bare provider, unchanged)
 *   provider: env with auth present → DispatchingSecretProvider
 *   provider: 1password with auth present → DispatchingSecretProvider
 */
import { describe, it, expect } from "vitest";
import { secretsFromConfig } from "../src/secrets/factory.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { OnePasswordProvider } from "../src/secrets/onepassword-provider.js";
import { DispatchingSecretProvider } from "../src/secrets/dispatching-provider.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

describe("secretsFromConfig", () => {
  it("returns an EnvProvider for provider: env", () => {
    const provider = secretsFromConfig({ provider: "env" });
    expect(provider).toBeInstanceOf(EnvProvider);
  });

  it("returns an OnePasswordProvider for provider: 1password", () => {
    const provider = secretsFromConfig({
      provider: "1password",
      // Supply the new service-aware shape (account, field, services);
      // minimal valid config — factory passes it straight through.
      onepassword: {
        vault: "Engineering",
        account: "praetorianlabs.1password.com",
        field: "password",
        refTemplate: "op://{vault}/{item}/{field}",
        cliPath: "op",
        services: {
          MY_KEY: { item: "My Item" },
        },
      },
    });
    expect(provider).toBeInstanceOf(OnePasswordProvider);
  });

  it("returns an OnePasswordProvider even when onepassword config is omitted", () => {
    // The provider applies its own defaults; an absent sub-object must not crash.
    const provider = secretsFromConfig({ provider: "1password" });
    expect(provider).toBeInstanceOf(OnePasswordProvider);
  });

  it("throws GatewayError with code config_invalid for an unknown provider", () => {
    expect(() => secretsFromConfig({ provider: "bogus" as never })).toThrow(GatewayError);
    try {
      secretsFromConfig({ provider: "bogus" as never });
    } catch (e) {
      expect((e as GatewayError).code).toBe("config_invalid");
    }
  });
});

// ── T10 back-compat (Cycle 1 subset) ──────────────────────────────────────────
//
// Asserts that env/1password providers with NO auth key still return the bare
// provider unchanged (the 410 existing tests' expectations remain intact).
// The DispatchingSecretProvider branch (with auth present) is Cycle 2 — left as
// todo until C10 is implemented.

describe("secretsFromConfig — T10 back-compat (no auth map)", () => {
  it("provider: env with NO auth key returns instanceof EnvProvider", () => {
    const provider = secretsFromConfig({ provider: "env" });
    expect(provider).toBeInstanceOf(EnvProvider);
  });

  it("provider: 1password with NO auth key returns instanceof OnePasswordProvider", () => {
    const provider = secretsFromConfig({
      provider: "1password",
      onepassword: {
        vault: "Engineering",
        account: "praetorianlabs.1password.com",
        field: "password",
        refTemplate: "op://{vault}/{item}/{field}",
        cliPath: "op",
        services: {
          MY_KEY: { item: "My Item" },
        },
      },
    });
    expect(provider).toBeInstanceOf(OnePasswordProvider);
  });

  it("provider: env WITH auth map present returns instanceof DispatchingSecretProvider (Cycle 2)", () => {
    // secrets.auth with a valid oauth row pointing to the default 'linear' provider
    const provider = secretsFromConfig({
      provider: "env",
      auth: {
        LINEAR_API_KEY: { type: "oauth", store: "claude-oauth", provider: "linear" },
      },
      oauth: {
        linear: {
          authorizeUrl: "https://linear.app/oauth/authorize",
          tokenUrl: "https://api.linear.app/oauth/token",
          clientId: "c22fe7e6dfa9be091c5ea19f6121307f",
          pkce: true,
          scopes: ["read", "write", "issues:create"],
          actor: "user",
          redirect: "http://localhost:14881/oauth/callback",
          header: "Bearer {token}",
        },
      },
    });
    expect(provider).toBeInstanceOf(DispatchingSecretProvider);
  });

  it("provider: 1password WITH auth map present returns instanceof DispatchingSecretProvider (Cycle 2)", () => {
    const provider = secretsFromConfig({
      provider: "1password",
      onepassword: {
        vault: "Engineering",
        account: "praetorianlabs.1password.com",
        field: "password",
        refTemplate: "op://{vault}/{item}/{field}",
        cliPath: "op",
        services: {
          MY_KEY: { item: "My Item" },
        },
      },
      auth: {
        LINEAR_API_KEY: { type: "oauth", store: "claude-oauth", provider: "linear" },
      },
      oauth: {
        linear: {
          authorizeUrl: "https://linear.app/oauth/authorize",
          tokenUrl: "https://api.linear.app/oauth/token",
          clientId: "c22fe7e6dfa9be091c5ea19f6121307f",
          pkce: true,
          scopes: ["read", "write", "issues:create"],
          actor: "user",
          redirect: "http://localhost:14881/oauth/callback",
          header: "Bearer {token}",
        },
      },
    });
    expect(provider).toBeInstanceOf(DispatchingSecretProvider);
  });
});
