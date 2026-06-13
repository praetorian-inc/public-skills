/**
 * secretsFromConfig coverage.
 *
 * Mirrors the rankerFromConfig block in keyword-ranker.test.ts:
 *   env       → returns an EnvProvider instance (P0 regression guard)
 *   1password → returns an OnePasswordProvider instance (WS-2; replaces the P0
 *               config_invalid throw)
 *   unknown   → throws GatewayError with code "config_invalid"
 */
import { describe, it, expect } from "vitest";
import { secretsFromConfig } from "../src/secrets/factory.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { OnePasswordProvider } from "../src/secrets/onepassword-provider.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

describe("secretsFromConfig", () => {
  it("returns an EnvProvider for provider: env", () => {
    const provider = secretsFromConfig({ provider: "env" });
    expect(provider).toBeInstanceOf(EnvProvider);
  });

  it("returns an OnePasswordProvider for provider: 1password", () => {
    const provider = secretsFromConfig({
      provider: "1password",
      onepassword: { vault: "Engineering", refTemplate: "op://{vault}/{key}/password", cliPath: "op" },
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
