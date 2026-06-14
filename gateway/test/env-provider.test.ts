import { describe, it, expect, afterEach } from "vitest";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

const TEST_KEYS = ["GW_TEST_A", "GW_TEST_B", "GW_TEST_MISSING"];

afterEach(() => {
  for (const k of TEST_KEYS) delete process.env[k];
});

describe("EnvProvider", () => {
  it("resolves present env keys into a record", async () => {
    process.env.GW_TEST_A = "alpha";
    process.env.GW_TEST_B = "beta";
    const provider = new EnvProvider();
    const secrets = await provider.resolve(["GW_TEST_A", "GW_TEST_B"]);
    expect(secrets).toEqual({ GW_TEST_A: "alpha", GW_TEST_B: "beta" });
  });

  it("returns an empty record for an empty key list", async () => {
    const provider = new EnvProvider();
    expect(await provider.resolve([])).toEqual({});
  });

  it("throws a missing_secret error naming the missing key", async () => {
    process.env.GW_TEST_A = "alpha";
    const provider = new EnvProvider();
    await expect(provider.resolve(["GW_TEST_A", "GW_TEST_MISSING"])).rejects.toThrow(
      /GW_TEST_MISSING/,
    );
  });

  it("throws a GatewayError with code missing_secret", async () => {
    const provider = new EnvProvider();
    try {
      await provider.resolve(["GW_TEST_MISSING"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("missing_secret");
    }
  });

  it("treats an empty-string env value as missing", async () => {
    process.env.GW_TEST_A = "";
    const provider = new EnvProvider();
    await expect(provider.resolve(["GW_TEST_A"])).rejects.toThrow(/GW_TEST_A/);
  });

  it("resolves LINEAR_API_KEY via flat-key fast-path (unmapped under 1password, resolvable via env)", async () => {
    // LINEAR_API_KEY is intentionally absent from the default 1Password services map
    // (no marketplace SDK item). Under EnvProvider it still resolves via the
    // flat-key fast-path: process.env["LINEAR_API_KEY"].
    process.env.GW_TEST_A = "lin-tok-abc";
    const provider = new EnvProvider();
    // Simulate the flat-key fast-path using our test key (same code path)
    const secrets = await provider.resolve(["GW_TEST_A"]);
    expect(secrets["GW_TEST_A"]).toBe("lin-tok-abc");
  });

  it("routes entries through parseAuthEntry (trims whitespace from entry)", async () => {
    // The shared seam: EnvProvider uses parseAuthEntry, so trimming happens.
    process.env.GW_TEST_A = "trimmed-value";
    const provider = new EnvProvider();
    // An entry with surrounding whitespace should trim to the flat key name
    const secrets = await provider.resolve(["  GW_TEST_A  "]);
    expect(secrets["GW_TEST_A"]).toBe("trimmed-value");
  });
});
