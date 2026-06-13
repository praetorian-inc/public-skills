/**
 * SF-2 / MEDIUM-1 — secretsFromConfig coverage.
 *
 * Mirrors the rankerFromConfig block in keyword-ranker.test.ts:
 *   env  → returns an EnvProvider instance
 *   1password → throws GatewayError with code "config_invalid"
 *   unknown   → throws GatewayError with code "config_invalid"
 */
import { describe, it, expect } from "vitest";
import { secretsFromConfig } from "../src/secrets/factory.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

describe("secretsFromConfig", () => {
  it("returns an EnvProvider for provider: env", () => {
    const provider = secretsFromConfig({ provider: "env" });
    expect(provider).toBeInstanceOf(EnvProvider);
  });

  it("throws GatewayError with code config_invalid for provider: 1password", () => {
    expect(() => secretsFromConfig({ provider: "1password" })).toThrow(GatewayError);
    try {
      secretsFromConfig({ provider: "1password" });
    } catch (e) {
      expect((e as GatewayError).code).toBe("config_invalid");
    }
  });

  it("throws GatewayError with code config_invalid for an unknown provider", () => {
    expect(() =>
      secretsFromConfig({ provider: "bogus" as never }),
    ).toThrow(GatewayError);
    try {
      secretsFromConfig({ provider: "bogus" as never });
    } catch (e) {
      expect((e as GatewayError).code).toBe("config_invalid");
    }
  });
});
