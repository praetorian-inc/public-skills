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
});
