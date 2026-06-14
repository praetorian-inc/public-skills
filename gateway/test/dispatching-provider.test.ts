/**
 * T6 — DispatchingSecretProvider (plan §2 C10, §5, Risk 4)
 *
 * Tests that:
 *   - Mixed keys partition correctly: oauth keys go to the oauth provider,
 *     env/api-key keys go to the global provider
 *   - The global provider mock receives ONLY the non-oauth keys — NOT the oauth
 *     keys (this is the load-bearing partition, plan Risk 4)
 *   - The oauth provider mock receives ONLY the oauth-strategy keys
 *   - The merged record is keyed by flat key and contains all resolved values
 *   - Empty keys → {} with NO provider invoked (context7 keyless path)
 *
 * All providers are fakes; no real env/1password/OAuth is touched.
 *
 * Imports from `src/secrets/dispatching-provider.ts` which does not exist yet
 * (RED phase).
 */
import { describe, it, expect, vi } from "vitest";
import { DispatchingSecretProvider } from "../src/secrets/dispatching-provider.js";
import type { SecretProvider } from "../src/secrets/provider.js";
import type { AuthMap } from "../src/secrets/auth-strategy.js";

// ── helpers ────────────────────────────────────────────────────────────────────

/** Create a fake SecretProvider that resolves each key to a fixed value map. */
function fakeProvider(
  resolvedValues: Record<string, string>,
  spy?: ReturnType<typeof vi.fn>,
): SecretProvider & { calls: string[][] } {
  const calls: string[][] = [];
  const resolve = vi.fn(async (keys: string[]): Promise<Record<string, string>> => {
    calls.push([...keys]);
    if (spy) spy(keys);
    const result: Record<string, string> = {};
    for (const k of keys) {
      if (k in resolvedValues) result[k] = resolvedValues[k];
      else throw new Error(`fakeProvider: unexpected key ${k}`);
    }
    return result;
  });
  return { resolve, calls };
}

/** Default auth map: LINEAR_API_KEY → oauth/linear; others → implicit api-key. */
const AUTH_MAP_MIXED: AuthMap = {
  LINEAR_API_KEY: { type: "oauth", store: "claude-oauth", provider: "linear" },
};

// ── happy path: partition + merge ─────────────────────────────────────────────

describe("DispatchingSecretProvider — mixed key partition", () => {
  it("routes oauth keys to the oauth provider and env keys to the global provider", async () => {
    const globalProvider = fakeProvider({
      PERPLEXITY_API_KEY: "perplexity-value",
      FEATUREBASE_API_KEY: "featurebase-value",
    });
    const oauthProvider = fakeProvider({ LINEAR_API_KEY: "Bearer linear-token" });

    const dispatcher = new DispatchingSecretProvider({
      globalProvider,
      oauthProvider,
      authMap: AUTH_MAP_MIXED,
      globalProviderKind: "env",
    });

    const result = await dispatcher.resolve([
      "LINEAR_API_KEY",
      "PERPLEXITY_API_KEY",
      "FEATUREBASE_API_KEY",
    ]);

    expect(result).toEqual({
      LINEAR_API_KEY: "Bearer linear-token",
      PERPLEXITY_API_KEY: "perplexity-value",
      FEATUREBASE_API_KEY: "featurebase-value",
    });
  });

  it("global provider receives ONLY the non-oauth keys (load-bearing partition — Risk 4)", async () => {
    const globalSpy = vi.fn<[string[]], Promise<Record<string, string>>>();
    const globalProvider = fakeProvider(
      { PERPLEXITY_API_KEY: "p", FEATUREBASE_API_KEY: "f" },
      globalSpy,
    );
    const oauthProvider = fakeProvider({ LINEAR_API_KEY: "Bearer lt" });

    const dispatcher = new DispatchingSecretProvider({
      globalProvider,
      oauthProvider,
      authMap: AUTH_MAP_MIXED,
      globalProviderKind: "env",
    });

    await dispatcher.resolve(["LINEAR_API_KEY", "PERPLEXITY_API_KEY", "FEATUREBASE_API_KEY"]);

    // The critical assertion: global provider MUST NOT see LINEAR_API_KEY
    expect(globalSpy).toHaveBeenCalledOnce();
    const receivedByGlobal = globalSpy.mock.calls[0][0];
    expect(receivedByGlobal).not.toContain("LINEAR_API_KEY");
    expect(receivedByGlobal).toContain("PERPLEXITY_API_KEY");
    expect(receivedByGlobal).toContain("FEATUREBASE_API_KEY");
  });

  it("oauth provider receives ONLY the oauth-strategy keys", async () => {
    const oauthSpy = vi.fn<[string[]], Promise<Record<string, string>>>();
    const globalProvider = fakeProvider({ PERPLEXITY_API_KEY: "p" });
    const oauthProvider = fakeProvider({ LINEAR_API_KEY: "Bearer lt" }, oauthSpy);

    const dispatcher = new DispatchingSecretProvider({
      globalProvider,
      oauthProvider,
      authMap: AUTH_MAP_MIXED,
      globalProviderKind: "env",
    });

    await dispatcher.resolve(["LINEAR_API_KEY", "PERPLEXITY_API_KEY"]);

    expect(oauthSpy).toHaveBeenCalledOnce();
    const receivedByOauth = oauthSpy.mock.calls[0][0];
    expect(receivedByOauth).toContain("LINEAR_API_KEY");
    expect(receivedByOauth).not.toContain("PERPLEXITY_API_KEY");
  });

  it("merged record is flat-keyed and contains all resolved values", async () => {
    const globalProvider = fakeProvider({ A: "val-a", B: "val-b" });
    const oauthProvider = fakeProvider({ C: "Bearer val-c", D: "Bearer val-d" });

    const authMap: AuthMap = {
      C: { type: "oauth", store: "claude-oauth", provider: "linear" },
      D: { type: "oauth", store: "claude-oauth", provider: "linear" },
    };

    const dispatcher = new DispatchingSecretProvider({
      globalProvider,
      oauthProvider,
      authMap,
      globalProviderKind: "env",
    });

    const result = await dispatcher.resolve(["A", "B", "C", "D"]);
    expect(result).toEqual({
      A: "val-a",
      B: "val-b",
      C: "Bearer val-c",
      D: "Bearer val-d",
    });
  });
});

// ── empty keys ─────────────────────────────────────────────────────────────────

describe("DispatchingSecretProvider — empty keys", () => {
  it("returns {} when resolve([]) is called (context7 keyless path)", async () => {
    const globalSpy = vi.fn();
    const oauthSpy = vi.fn();
    const globalProvider = { resolve: globalSpy } as unknown as SecretProvider;
    const oauthProvider = { resolve: oauthSpy } as unknown as SecretProvider;

    const dispatcher = new DispatchingSecretProvider({
      globalProvider,
      oauthProvider,
      authMap: AUTH_MAP_MIXED,
      globalProviderKind: "env",
    });

    const result = await dispatcher.resolve([]);
    expect(result).toEqual({});
    // Neither provider is invoked for empty keys
    expect(globalSpy).not.toHaveBeenCalled();
    expect(oauthSpy).not.toHaveBeenCalled();
  });
});

// ── all oauth keys ─────────────────────────────────────────────────────────────

describe("DispatchingSecretProvider — all oauth keys", () => {
  it("when all keys are oauth, global provider is NOT called", async () => {
    const globalSpy = vi.fn();
    const globalProvider = { resolve: globalSpy } as unknown as SecretProvider;
    const oauthProvider = fakeProvider({ LINEAR_API_KEY: "Bearer lt" });

    const dispatcher = new DispatchingSecretProvider({
      globalProvider,
      oauthProvider,
      authMap: AUTH_MAP_MIXED,
      globalProviderKind: "env",
    });

    const result = await dispatcher.resolve(["LINEAR_API_KEY"]);
    expect(result).toEqual({ LINEAR_API_KEY: "Bearer lt" });
    expect(globalSpy).not.toHaveBeenCalled();
  });
});

// ── all non-oauth keys ─────────────────────────────────────────────────────────

describe("DispatchingSecretProvider — all non-oauth keys", () => {
  it("when all keys are non-oauth, oauth provider is NOT called", async () => {
    const oauthSpy = vi.fn();
    const globalProvider = fakeProvider({ A: "val-a", B: "val-b" });
    const oauthProvider = { resolve: oauthSpy } as unknown as SecretProvider;

    const dispatcher = new DispatchingSecretProvider({
      globalProvider,
      oauthProvider,
      authMap: AUTH_MAP_MIXED, // only LINEAR_API_KEY is oauth
      globalProviderKind: "env",
    });

    const result = await dispatcher.resolve(["A", "B"]);
    expect(result).toEqual({ A: "val-a", B: "val-b" });
    expect(oauthSpy).not.toHaveBeenCalled();
  });
});

// ── absent authMap (no dispatch needed) ───────────────────────────────────────

describe("DispatchingSecretProvider — absent or empty authMap", () => {
  it("all keys go to global when authMap is undefined", async () => {
    const globalProvider = fakeProvider({ FOO: "foo-val", BAR: "bar-val" });
    const oauthSpy = vi.fn();
    const oauthProvider = { resolve: oauthSpy } as unknown as SecretProvider;

    const dispatcher = new DispatchingSecretProvider({
      globalProvider,
      oauthProvider,
      authMap: undefined,
      globalProviderKind: "env",
    });

    const result = await dispatcher.resolve(["FOO", "BAR"]);
    expect(result).toEqual({ FOO: "foo-val", BAR: "bar-val" });
    expect(oauthSpy).not.toHaveBeenCalled();
  });

  it("all keys go to global when authMap is empty", async () => {
    const globalProvider = fakeProvider({ FOO: "foo-val" });
    const oauthSpy = vi.fn();
    const oauthProvider = { resolve: oauthSpy } as unknown as SecretProvider;

    const dispatcher = new DispatchingSecretProvider({
      globalProvider,
      oauthProvider,
      authMap: {},
      globalProviderKind: "env",
    });

    const result = await dispatcher.resolve(["FOO"]);
    expect(result).toEqual({ FOO: "foo-val" });
    expect(oauthSpy).not.toHaveBeenCalled();
  });
});

// ── explicit api-key and env strategy rows still go to global ─────────────────

describe("DispatchingSecretProvider — explicit api-key / env rows route to global", () => {
  it("explicit api-key row is routed to global, not oauth", async () => {
    const authMap: AuthMap = {
      MY_KEY: { type: "api-key" },
    };
    const globalProvider = fakeProvider({ MY_KEY: "api-key-val" });
    const oauthSpy = vi.fn();
    const oauthProvider = { resolve: oauthSpy } as unknown as SecretProvider;

    const dispatcher = new DispatchingSecretProvider({
      globalProvider,
      oauthProvider,
      authMap,
      globalProviderKind: "env",
    });

    const result = await dispatcher.resolve(["MY_KEY"]);
    expect(result).toEqual({ MY_KEY: "api-key-val" });
    expect(oauthSpy).not.toHaveBeenCalled();
  });

  it("explicit env row is routed to global, not oauth", async () => {
    const authMap: AuthMap = {
      ENV_KEY: { type: "env" },
    };
    const globalProvider = fakeProvider({ ENV_KEY: "env-val" });
    const oauthSpy = vi.fn();
    const oauthProvider = { resolve: oauthSpy } as unknown as SecretProvider;

    const dispatcher = new DispatchingSecretProvider({
      globalProvider,
      oauthProvider,
      authMap,
      globalProviderKind: "env",
    });

    const result = await dispatcher.resolve(["ENV_KEY"]);
    expect(result).toEqual({ ENV_KEY: "env-val" });
    expect(oauthSpy).not.toHaveBeenCalled();
  });
});
