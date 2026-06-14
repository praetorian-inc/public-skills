/**
 * T5 — resolveStrategy
 *
 * Tests that:
 *   - A key absent from authMap resolves to { type: "api-key", store: <globalProvider> }
 *     (today's default behavior, exactly)
 *   - An explicit oauth row resolves to the oauth strategy with the correct store + provider
 *   - An env-type row resolves to { type: "env" }
 *   - An api-key-type row resolves to { type: "api-key", store: <globalProvider> }
 *
 * Note: the plan calls for config-level invalid-provider validation (superRefine) to be
 * tested in T7/config-auth.test.ts. resolveStrategy itself resolves rows that are
 * structurally valid (the authMap has already passed config parsing); the config_invalid
 * for unknown provider lives in T7 where the full ConfigSchema is exercised.
 *
 * Imports from `src/secrets/auth-strategy.ts` which does not exist yet (RED phase).
 */
import { describe, it, expect } from "vitest";
import { resolveStrategy } from "../src/secrets/auth-strategy.js";

describe("resolveStrategy — absent key (default behavior)", () => {
  it("returns api-key strategy with env as store when key is absent and global is env", () => {
    const result = resolveStrategy("LINEAR_API_KEY", undefined, "env");
    expect(result).toEqual({ type: "api-key", store: "env" });
  });

  it("returns api-key strategy with 1password as store when key is absent and global is 1password", () => {
    const result = resolveStrategy("PERPLEXITY_API_KEY", undefined, "1password");
    expect(result).toEqual({ type: "api-key", store: "1password" });
  });

  it("returns api-key strategy when authMap is an empty object", () => {
    const result = resolveStrategy("LINEAR_API_KEY", {}, "env");
    expect(result).toEqual({ type: "api-key", store: "env" });
  });

  it("returns api-key strategy when key is not in authMap but authMap has other entries", () => {
    const authMap = {
      SOME_OTHER_KEY: { type: "oauth" as const, store: "claude-oauth" as const, provider: "linear" },
    };
    const result = resolveStrategy("UNRELATED_KEY", authMap, "env");
    expect(result).toEqual({ type: "api-key", store: "env" });
  });
});

describe("resolveStrategy — explicit oauth row", () => {
  it("resolves a claude-oauth oauth row for linear", () => {
    const authMap = {
      LINEAR_API_KEY: { type: "oauth" as const, store: "claude-oauth" as const, provider: "linear" },
    };
    const result = resolveStrategy("LINEAR_API_KEY", authMap, "env");
    expect(result).toEqual({ type: "oauth", store: "claude-oauth", provider: "linear" });
  });

  it("resolves a 1password oauth store row", () => {
    const authMap = {
      SOME_OAUTH_KEY: { type: "oauth" as const, store: "1password" as const, provider: "some-svc" },
    };
    const result = resolveStrategy("SOME_OAUTH_KEY", authMap, "1password");
    expect(result).toEqual({ type: "oauth", store: "1password", provider: "some-svc" });
  });

  it("preserves the provider name from the authMap row", () => {
    const authMap = {
      MY_KEY: { type: "oauth" as const, store: "claude-oauth" as const, provider: "my-custom-provider" },
    };
    const result = resolveStrategy("MY_KEY", authMap, "env");
    if (result.type === "oauth") {
      expect(result.provider).toBe("my-custom-provider");
    } else {
      throw new Error("Expected oauth strategy");
    }
  });
});

describe("resolveStrategy — explicit env and api-key rows", () => {
  it("resolves an explicit env-type row to { type: env }", () => {
    const authMap = {
      MY_ENV_KEY: { type: "env" as const },
    };
    const result = resolveStrategy("MY_ENV_KEY", authMap, "env");
    expect(result.type).toBe("env");
  });

  it("resolves an explicit api-key-type row with store mirroring the global provider", () => {
    const authMap = {
      MY_API_KEY: { type: "api-key" as const },
    };
    const result = resolveStrategy("MY_API_KEY", authMap, "1password");
    expect(result.type).toBe("api-key");
    if (result.type === "api-key") {
      expect(result.store).toBe("1password");
    }
  });

  it("resolves explicit api-key with env global provider", () => {
    const authMap = {
      MY_API_KEY: { type: "api-key" as const },
    };
    const result = resolveStrategy("MY_API_KEY", authMap, "env");
    expect(result.type).toBe("api-key");
    if (result.type === "api-key") {
      expect(result.store).toBe("env");
    }
  });
});

describe("resolveStrategy — global provider propagation", () => {
  it("absent key with env global yields { type: api-key, store: env }", () => {
    const strategy = resolveStrategy("ANY_KEY", undefined, "env");
    expect(strategy).toEqual({ type: "api-key", store: "env" });
  });

  it("absent key with 1password global yields { type: api-key, store: 1password }", () => {
    const strategy = resolveStrategy("ANY_KEY", undefined, "1password");
    expect(strategy).toEqual({ type: "api-key", store: "1password" });
  });
});
