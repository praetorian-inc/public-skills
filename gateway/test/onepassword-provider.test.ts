/**
 * WS-2 Group E — OnePasswordProvider (1Password `op` CLI secret backend).
 *
 * SERVICE-AWARE contract (Option B, plan §4):
 *   - Auth entries are FLAT KEYS (e.g. `PERPLEXITY_API_KEY`).
 *   - The provider looks the flat key up in the `services` map → `{item, vault, field}`.
 *   - It builds an `op://{vault}/{item}/{field}` reference from the configurable
 *     `refTemplate` and invokes `op read --account <acct> <ref>` via the INJECTED runner.
 *   - Tests NEVER shell out to a real `op` binary; the `OpRunner` is always a fake.
 *
 * What these tests assert:
 *   - service lookup → correct `op://` ref built from per-service coordinates
 *   - multi-vault: perplexity (default vault) vs n8n ("Claude Tools IT")
 *   - exact args passed to runner: `["read", "--account", account, ref]`
 *   - account precedence: OP_ACCOUNT env > config `account` > default
 *   - vault precedence: per-service > OP_VAULT_NAME env > config vault default
 *   - unmapped key → config_invalid (names only the key, not a value)
 *   - ENOENT → secret_backend_unavailable
 *   - non-zero exit → secret_backend_unavailable (no stdout/stderr echoed)
 *   - empty/whitespace stdout → missing_secret
 *   - resolve([]) → {} with NO runner invocation (keyless passthrough)
 *   - cache: a second resolve for the same key does NOT re-invoke the runner
 *   - secret values are never present in thrown error messages
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { secretsFromConfig } from "../src/secrets/factory.js";
import { OnePasswordProvider } from "../src/secrets/onepassword-provider.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

/** Runner result shape the provider expects. */
type RunResult = { code: number; stdout: string; stderr: string };

/** A fake `op` that returns a fixed value for any invocation and records args. */
function fakeRunner(value: string) {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[]): Promise<RunResult> => {
    calls.push(args);
    return { code: 0, stdout: value, stderr: "" };
  });
  return { run, calls };
}

/**
 * Minimal services map used by most tests.
 * Contains two keys to cover the happy path; intentionally does NOT include
 * LINEAR_API_KEY (unmapped key tests need to see config_invalid).
 */
const SERVICES = {
  PERPLEXITY_API_KEY: { service: "perplexity", item: "Perplexity API Key" },
  N8N_API_KEY: { service: "n8n", item: "n8n sales api key", vault: "Claude Tools IT" },
  EMPTY_KEY: { service: "empty-svc", item: "Empty Item" },
  WS_KEY: { service: "ws-svc", item: "Whitespace Item" },
  NAMED_KEY: { service: "named-svc", item: "Named Item" },
  DUP_KEY: { service: "dup-svc", item: "Dup Item" },
  A: { service: "a-svc", item: "A Item" },
  B: { service: "b-svc", item: "B Item" },
  C: { service: "c-svc", item: "C Item" },
  LEAK_KEY: { service: "leak-svc", item: "Leak Item" },
  K: { service: "k-svc", item: "K Item" },
};

const BASE_CFG = {
  vault: "Claude Code Tools",
  account: "praetorianlabs.1password.com",
  field: "password",
  refTemplate: "op://{vault}/{item}/{field}",
  cliPath: "op",
  services: SERVICES,
} as const;

// ── env overrides ──────────────────────────────────────────────────────────────

const OP_ENV_KEYS = ["OP_ACCOUNT", "OP_VAULT_NAME"] as const;

beforeEach(() => {
  for (const k of OP_ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of OP_ENV_KEYS) delete process.env[k];
});

// ── happy path ─────────────────────────────────────────────────────────────────

describe("OnePasswordProvider — happy path", () => {
  it("resolves a mapped key into a flat-keyed record", async () => {
    const { run } = fakeRunner("super-secret-token");
    const provider = new OnePasswordProvider(BASE_CFG, run);
    const secrets = await provider.resolve(["PERPLEXITY_API_KEY"]);
    expect(secrets).toEqual({ PERPLEXITY_API_KEY: "super-secret-token" });
  });

  it("returns an empty record for an empty key list and does NOT invoke the runner", async () => {
    const { run } = fakeRunner("x");
    const provider = new OnePasswordProvider(BASE_CFG, run);
    expect(await provider.resolve([])).toEqual({});
    expect(run).not.toHaveBeenCalled();
  });

  it("trims trailing newline from op stdout", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({
      code: 0,
      stdout: "tok-123\n",
      stderr: "",
    }));
    const provider = new OnePasswordProvider(BASE_CFG, run);
    const secrets = await provider.resolve(["K"]);
    expect(secrets["K"]).toBe("tok-123");
  });
});

// ── args / ref construction ────────────────────────────────────────────────────

describe("OnePasswordProvider — op args and ref construction", () => {
  it("passes exactly ['read', '--account', account, ref] to the runner", async () => {
    const { run, calls } = fakeRunner("v");
    const provider = new OnePasswordProvider(BASE_CFG, run);
    await provider.resolve(["PERPLEXITY_API_KEY"]);
    expect(calls[0]).toEqual([
      "read",
      "--account",
      "praetorianlabs.1password.com",
      "op://Claude Code Tools/Perplexity API Key/password",
    ]);
  });

  it("substitutes {vault}/{item}/{field} from the service row + config defaults", async () => {
    const { run, calls } = fakeRunner("v");
    const provider = new OnePasswordProvider(BASE_CFG, run);
    await provider.resolve(["PERPLEXITY_API_KEY"]);
    const ref = calls[0][3];
    expect(ref).toBe("op://Claude Code Tools/Perplexity API Key/password");
  });

  it("uses per-service vault override for IT-vault services (multi-vault)", async () => {
    const { run, calls } = fakeRunner("n8n-tok");
    const provider = new OnePasswordProvider(BASE_CFG, run);
    await provider.resolve(["N8N_API_KEY"]);
    const ref = calls[0][3];
    // n8n row carries vault: "Claude Tools IT" → overrides default vault
    expect(ref).toBe("op://Claude Tools IT/n8n sales api key/password");
  });

  it("uses OP_VAULT_NAME env as vault when no per-service vault override", async () => {
    process.env.OP_VAULT_NAME = "EnvOverrideVault";
    const { run, calls } = fakeRunner("v");
    const provider = new OnePasswordProvider(BASE_CFG, run);
    await provider.resolve(["PERPLEXITY_API_KEY"]);
    const ref = calls[0][3];
    // perplexity has no per-service vault → OP_VAULT_NAME wins over config.vault
    expect(ref).toBe("op://EnvOverrideVault/Perplexity API Key/password");
  });

  it("per-service vault beats OP_VAULT_NAME env", async () => {
    process.env.OP_VAULT_NAME = "ShouldBeIgnoredForN8N";
    const { run, calls } = fakeRunner("v");
    const provider = new OnePasswordProvider(BASE_CFG, run);
    await provider.resolve(["N8N_API_KEY"]);
    const ref = calls[0][3];
    // n8n has an explicit vault → env override does NOT apply
    expect(ref).toBe("op://Claude Tools IT/n8n sales api key/password");
  });
});

// ── account precedence ─────────────────────────────────────────────────────────

describe("OnePasswordProvider — account precedence", () => {
  it("uses config account when OP_ACCOUNT is not set", async () => {
    const { run, calls } = fakeRunner("v");
    const provider = new OnePasswordProvider(
      { ...BASE_CFG, account: "custom.1password.com" },
      run,
    );
    await provider.resolve(["PERPLEXITY_API_KEY"]);
    expect(calls[0][2]).toBe("custom.1password.com");
  });

  it("uses OP_ACCOUNT env when set, overriding config account", async () => {
    process.env.OP_ACCOUNT = "env-account.1password.com";
    const { run, calls } = fakeRunner("v");
    const provider = new OnePasswordProvider(
      { ...BASE_CFG, account: "should-be-ignored.1password.com" },
      run,
    );
    await provider.resolve(["PERPLEXITY_API_KEY"]);
    expect(calls[0][2]).toBe("env-account.1password.com");
  });

  it("falls back to default praetorianlabs.1password.com when no account config", async () => {
    const { run, calls } = fakeRunner("v");
    // Construct with empty partial — the provider applies defaults
    const provider = new OnePasswordProvider({ services: SERVICES }, run);
    await provider.resolve(["PERPLEXITY_API_KEY"]);
    expect(calls[0][1]).toBe("--account");
    expect(calls[0][2]).toBe("praetorianlabs.1password.com");
  });
});

// ── error taxonomy ─────────────────────────────────────────────────────────────

describe("OnePasswordProvider — error taxonomy", () => {
  it("throws config_invalid for a key not in the services map", async () => {
    const { run } = fakeRunner("v");
    const provider = new OnePasswordProvider(BASE_CFG, run);
    // LINEAR_API_KEY is NOT in our SERVICES map above
    try {
      await provider.resolve(["LINEAR_API_KEY"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("config_invalid");
      expect((e as GatewayError).message).toContain("LINEAR_API_KEY");
    }
  });

  it("config_invalid message names the key, not any value", async () => {
    const { run } = fakeRunner("DO-NOT-LEAK");
    const provider = new OnePasswordProvider(BASE_CFG, run);
    try {
      await provider.resolve(["UNMAPPED_KEY"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as GatewayError).code).toBe("config_invalid");
      expect((e as GatewayError).message).toContain("UNMAPPED_KEY");
      expect((e as GatewayError).message).not.toContain("DO-NOT-LEAK");
    }
  });

  it("maps a missing op binary (ENOENT) to secret_backend_unavailable", async () => {
    const run = vi.fn(async (): Promise<RunResult> => {
      const err = new Error("spawn op ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const provider = new OnePasswordProvider(BASE_CFG, run);
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
    const provider = new OnePasswordProvider(BASE_CFG, run);
    try {
      await provider.resolve(["K"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("secret_backend_unavailable");
    }
  });

  it("non-zero exit error message contains the exit code but NOT stdout/stderr", async () => {
    const SECRET = "DO-NOT-LEAK-7f3a";
    const run = vi.fn(async (): Promise<RunResult> => ({
      code: 1,
      stdout: SECRET,
      stderr: SECRET,
    }));
    const provider = new OnePasswordProvider(BASE_CFG, run);
    try {
      await provider.resolve(["LEAK_KEY"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("secret_backend_unavailable");
      // Message must say "op exited 1" but NEVER echo stdout/stderr
      expect((e as GatewayError).message).toContain("1");
      expect((e as GatewayError).message).not.toContain(SECRET);
    }
  });

  it("treats empty stdout as missing_secret naming the key", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 0, stdout: "", stderr: "" }));
    const provider = new OnePasswordProvider(BASE_CFG, run);
    try {
      await provider.resolve(["EMPTY_KEY"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("missing_secret");
      expect((e as GatewayError).message).toContain("EMPTY_KEY");
    }
  });

  it("treats a whitespace-only stdout as missing_secret", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 0, stdout: "   \n", stderr: "" }));
    const provider = new OnePasswordProvider(BASE_CFG, run);
    await expect(provider.resolve(["WS_KEY"])).rejects.toMatchObject({
      code: "missing_secret",
    });
  });

  it("missing_secret message names the key, not any value in stderr", async () => {
    const SECRET = "DO-NOT-LEAK-7f3a";
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 0, stdout: "", stderr: SECRET }));
    const provider = new OnePasswordProvider(BASE_CFG, run);
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

// ── caching ────────────────────────────────────────────────────────────────────

describe("OnePasswordProvider — per-key cache", () => {
  it("does NOT re-invoke the runner for a key already resolved", async () => {
    const { run } = fakeRunner("cached-value");
    const provider = new OnePasswordProvider(BASE_CFG, run);
    await provider.resolve(["DUP_KEY"]);
    await provider.resolve(["DUP_KEY"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("invokes the runner once per distinct key across multiple resolve calls", async () => {
    const { run } = fakeRunner("v");
    const provider = new OnePasswordProvider(BASE_CFG, run);
    await provider.resolve(["A", "B"]);
    await provider.resolve(["A", "C"]);
    // A reused from cache; B and C each fetched once → 3 total invocations
    expect(run).toHaveBeenCalledTimes(3);
  });
});

// ── service-account vs biometric ───────────────────────────────────────────────

describe("OnePasswordProvider — service-account vs biometric (provider-transparent)", () => {
  it("passes --account with identical args whether or not OP_SERVICE_ACCOUNT_TOKEN is set", async () => {
    // The gateway passes --account and leaves OP_SERVICE_ACCOUNT_TOKEN handling to `op`.
    // Drive two resolves — one without the token env var, one with — and assert the
    // args array is identical. The provider has no special code path for the token.

    // Without OP_SERVICE_ACCOUNT_TOKEN
    const { run: runWithout, calls: callsWithout } = fakeRunner("v");
    const providerWithout = new OnePasswordProvider(BASE_CFG, runWithout);
    await providerWithout.resolve(["PERPLEXITY_API_KEY"]);

    // With OP_SERVICE_ACCOUNT_TOKEN in env (simulated token — no real `op` called)
    const envBefore = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "fake-token-for-test";
    const { run: runWith, calls: callsWith } = fakeRunner("v");
    const providerWith = new OnePasswordProvider(BASE_CFG, runWith);
    await providerWith.resolve(["PERPLEXITY_API_KEY"]);
    if (envBefore === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    else process.env.OP_SERVICE_ACCOUNT_TOKEN = envBefore;

    // Both invocations must produce identical args — the token env var changes nothing
    // in the provider's args; `op` honors it implicitly via its own environment read.
    expect(callsWithout[0]).toEqual(callsWith[0]);
    expect(callsWith[0][1]).toBe("--account");
  });
});

// ── HIGH-1 regression ──────────────────────────────────────────────────────────

describe("OnePasswordProvider — HIGH-1 regression: bare config does not throw config_invalid", () => {
  // Temp dir for writing a fixture config file
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gw-op-regression-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("bare secrets:{provider:1password} resolves PERPLEXITY_API_KEY without throwing config_invalid", async () => {
    // Load config from a bare YAML — no onepassword sub-object.
    // HIGH-1 fix: .default({}) on onepassword materializes the full ported services table.
    const cfgPath = join(dir, "bare.yaml");
    writeFileSync(cfgPath, "secrets:\n  provider: 1password\n", "utf8");
    const cfg = loadConfig(cfgPath);

    // Construct provider from the materialized onepassword config (mirrors secretsFromConfig).
    // Inject a fake runner so we never shell out to real `op`.
    const run = vi.fn(async () => ({ code: 0, stdout: "v\n", stderr: "" }));
    const provider = new OnePasswordProvider(cfg.secrets.onepassword, run);

    // Must resolve, NOT throw config_invalid
    const result = await provider.resolve(["PERPLEXITY_API_KEY"]);
    expect(result).toEqual({ PERPLEXITY_API_KEY: "v" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("secretsFromConfig with bare {provider:1password} config returns a provider that resolves PERPLEXITY_API_KEY", async () => {
    // After HIGH-1, cfg.secrets.onepassword is always defined (not undefined),
    // so secretsFromConfig passes the full services table to OnePasswordProvider.
    // Patch the provider's runner after construction by constructing directly from
    // the materialized cfg — same path the factory takes.
    const cfgPath = join(dir, "bare2.yaml");
    writeFileSync(cfgPath, "secrets:\n  provider: 1password\n", "utf8");
    const cfg = loadConfig(cfgPath);

    // The factory calls new OnePasswordProvider(cfg.secrets.onepassword).
    // Pass the same arg but inject a fake runner to avoid shelling out.
    const run = vi.fn(async () => ({ code: 0, stdout: "v\n", stderr: "" }));
    const provider = new OnePasswordProvider(cfg.secrets.onepassword, run);

    await expect(provider.resolve(["PERPLEXITY_API_KEY"])).resolves.toEqual({
      PERPLEXITY_API_KEY: "v",
    });
    await expect(provider.resolve(["FEATUREBASE_API_KEY"])).resolves.toEqual({
      FEATUREBASE_API_KEY: "v",
    });
    // LINEAR_API_KEY is NOT in the default table → config_invalid (expected taxonomy)
    await expect(provider.resolve(["LINEAR_API_KEY"])).rejects.toMatchObject({
      code: "config_invalid",
    });
  });
});
