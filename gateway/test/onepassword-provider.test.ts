/**
 * WS-2 Group E — OnePasswordProvider (1Password `op` CLI secret backend).
 *
 * Mirrors env-provider.test.ts. The provider takes an INJECTED command runner
 * `(args) => Promise<{ code, stdout, stderr }>` so tests never shell out to a
 * real `op` binary. Verifies:
 *   - present keys → record of resolved values (op:// ref built from refTemplate)
 *   - absent/empty/whitespace value → missing_secret (reuses P0 code)
 *   - runner ENOENT / non-zero exit / auth failure → secret_backend_unavailable
 *   - a given key is resolved at most once per instance (cache; no re-invoke)
 *   - secret values are never present in thrown error messages (key names only)
 */
import { describe, it, expect, vi } from "vitest";
import { OnePasswordProvider } from "../src/secrets/onepassword-provider.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

/** Runner result shape the provider expects. */
type RunResult = { code: number; stdout: string; stderr: string };

/** A fake `op` that returns a fixed value for any key (records the args it saw). */
function fakeRunner(value: string) {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[]): Promise<RunResult> => {
    calls.push(args);
    return { code: 0, stdout: value, stderr: "" };
  });
  return { run, calls };
}

const VAULT_CFG = { vault: "Engineering", refTemplate: "op://{vault}/{key}/password", cliPath: "op" };

describe("OnePasswordProvider", () => {
  it("resolves present keys into a record of values", async () => {
    const { run } = fakeRunner("super-secret-token");
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    const secrets = await provider.resolve(["SF_ACCESS_TOKEN"]);
    expect(secrets).toEqual({ SF_ACCESS_TOKEN: "super-secret-token" });
  });

  it("returns an empty record for an empty key list (no runner calls)", async () => {
    const { run } = fakeRunner("x");
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    expect(await provider.resolve([])).toEqual({});
    expect(run).not.toHaveBeenCalled();
  });

  it("builds the op reference from refTemplate, substituting {vault} and {key}", async () => {
    const { run, calls } = fakeRunner("v");
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    await provider.resolve(["API_KEY"]);
    // The op reference must appear in the args passed to the runner.
    const flat = calls[0].join(" ");
    expect(flat).toContain("op://Engineering/API_KEY/password");
  });

  it("honours a custom refTemplate", async () => {
    const { run, calls } = fakeRunner("v");
    const provider = new OnePasswordProvider(
      { vault: "Shared", refTemplate: "op://{vault}/{key}", cliPath: "op" },
      run,
    );
    await provider.resolve(["DB_PASS"]);
    expect(calls[0].join(" ")).toContain("op://Shared/DB_PASS");
  });

  it("trims the op stdout (op appends a trailing newline)", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({
      code: 0,
      stdout: "tok-123\n",
      stderr: "",
    }));
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    const secrets = await provider.resolve(["K"]);
    expect(secrets).toEqual({ K: "tok-123" });
  });

  it("treats an empty value as missing_secret naming the key", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 0, stdout: "", stderr: "" }));
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    await expect(provider.resolve(["EMPTY_KEY"])).rejects.toThrow(/EMPTY_KEY/);
    try {
      await provider.resolve(["EMPTY_KEY"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("missing_secret");
    }
  });

  it("treats a whitespace-only value as missing_secret", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 0, stdout: "   \n", stderr: "" }));
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    await expect(provider.resolve(["WS_KEY"])).rejects.toThrow(/WS_KEY/);
  });

  it("maps a missing op binary (ENOENT) to secret_backend_unavailable", async () => {
    const run = vi.fn(async (): Promise<RunResult> => {
      const err = new Error("spawn op ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    try {
      await provider.resolve(["K"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("secret_backend_unavailable");
    }
  });

  it("maps a non-zero op exit to secret_backend_unavailable", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({
      code: 1,
      stdout: "",
      stderr: "[ERROR] you are not currently signed in",
    }));
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    try {
      await provider.resolve(["K"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("secret_backend_unavailable");
    }
  });

  it("does NOT re-invoke the runner for a key already resolved (cache)", async () => {
    const { run } = fakeRunner("cached-value");
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    await provider.resolve(["DUP_KEY"]);
    await provider.resolve(["DUP_KEY"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("invokes the runner once per distinct key across calls", async () => {
    const { run } = fakeRunner("v");
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    await provider.resolve(["A", "B"]);
    await provider.resolve(["A", "C"]);
    // A reused from cache; B and C each fetched once → 3 distinct invocations.
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("never echoes op stdout/stderr (which may hold a value) in a backend error", async () => {
    const SECRET = "DO-NOT-LEAK-7f3a";
    const run = vi.fn(async (): Promise<RunResult> => ({
      code: 1,
      stdout: SECRET,
      stderr: SECRET,
    }));
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    try {
      await provider.resolve(["LEAK_KEY"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("secret_backend_unavailable");
      // The captured op output is NEVER surfaced in the coded error.
      expect((e as GatewayError).message).not.toContain(SECRET);
    }
  });

  it("names the key (not the value) in a missing_secret error", async () => {
    const SECRET = "DO-NOT-LEAK-7f3a";
    // A non-empty-but-only-after-trim case can't carry the value into the error;
    // an empty value throws missing_secret which names the key, never a value.
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 0, stdout: "", stderr: SECRET }));
    const provider = new OnePasswordProvider(VAULT_CFG, run);
    try {
      await provider.resolve(["NAMED_KEY"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as GatewayError).code).toBe("missing_secret");
      expect((e as GatewayError).message).toContain("NAMED_KEY");
      expect((e as GatewayError).message).not.toContain(SECRET);
    }
  });
});
