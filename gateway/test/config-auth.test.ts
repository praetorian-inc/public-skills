/**
 * T7 — config-level OAuth schema additions (M1)
 *
 * Tests that:
 *   - Empty config is still valid (empty config stays valid property preserved)
 *   - secrets.oauth.linear default row is present in an empty config
 *   - The linear default row has: clientId "c22fe7e6dfa9be091c5ea19f6121307f",
 *     redirect "http://localhost:14881/oauth/callback", header "Bearer {token}",
 *     scopes ["read","write","issues:create"]
 *   - secrets.auth is undefined by default (not an empty object — it is optional)
 *   - superRefine REJECTS secrets.auth.X = {type:"oauth", provider:"nope"} when
 *     "nope" is not in secrets.oauth
 *   - superRefine REJECTS {type:"oauth"} with no provider field
 *
 * Mirrors the existing config.test.ts pattern: write YAML to a temp file →
 * loadConfig; or use configFromObject for in-memory object tests.
 *
 * Imports from `src/config.ts` (existing, but the new fields are not there yet —
 * RED phase: loadConfig({}) will succeed but won't have secrets.oauth.linear).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, configFromObject } from "../src/config.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gw-config-auth-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

// ── empty config validity ──────────────────────────────────────────────────────

describe("config-auth — empty config is still valid", () => {
  it("loadConfig with empty YAML produces a valid config", () => {
    const p = writeConfig("auth-empty.yaml", "{}\n");
    expect(() => loadConfig(p)).not.toThrow();
  });

  it("configFromObject({}) produces a valid config", () => {
    expect(() => configFromObject({})).not.toThrow();
  });

  it("configFromObject({}) does not throw even with existing superRefine clauses", () => {
    // Ensures adding M1 superRefine does not break the 'empty is valid' invariant
    const cfg = configFromObject({});
    expect(cfg).toBeDefined();
    expect(cfg.secrets).toBeDefined();
  });
});

// ── secrets.auth default ───────────────────────────────────────────────────────

describe("config-auth — secrets.auth defaults to undefined", () => {
  it("secrets.auth is undefined when not specified in empty config", () => {
    const cfg = configFromObject({});
    // secrets.auth is optional (NOT defaulted to {}), so absent ⇒ undefined
    expect((cfg.secrets as Record<string, unknown>).auth).toBeUndefined();
  });

  it("secrets.auth is undefined when not specified in YAML config", () => {
    const p = writeConfig("auth-no-auth-map.yaml", "secrets:\n  provider: env\n");
    const cfg = loadConfig(p);
    expect((cfg.secrets as Record<string, unknown>).auth).toBeUndefined();
  });
});

// ── secrets.oauth.linear default row ──────────────────────────────────────────

describe("config-auth — secrets.oauth.linear default row", () => {
  it("secrets.oauth is defined in empty config", () => {
    const cfg = configFromObject({});
    expect((cfg.secrets as Record<string, unknown>).oauth).toBeDefined();
  });

  it("secrets.oauth.linear is present in default config", () => {
    const cfg = configFromObject({});
    const oauth = (cfg.secrets as Record<string, unknown>).oauth as Record<string, unknown>;
    expect(oauth?.linear).toBeDefined();
  });

  it("linear default row has the correct clientId", () => {
    const cfg = configFromObject({});
    const oauth = (cfg.secrets as Record<string, unknown>).oauth as Record<string, Record<string, unknown>>;
    expect(oauth?.linear?.clientId).toBe("c22fe7e6dfa9be091c5ea19f6121307f");
  });

  it("linear default row has redirect pointing to localhost:14881", () => {
    const cfg = configFromObject({});
    const oauth = (cfg.secrets as Record<string, unknown>).oauth as Record<string, Record<string, unknown>>;
    expect(oauth?.linear?.redirect).toBe("http://localhost:14881/oauth/callback");
  });

  it("linear default row has header 'Bearer {token}'", () => {
    const cfg = configFromObject({});
    const oauth = (cfg.secrets as Record<string, unknown>).oauth as Record<string, Record<string, unknown>>;
    expect(oauth?.linear?.header).toBe("Bearer {token}");
  });

  it("linear default row has scopes ['read', 'write', 'issues:create']", () => {
    const cfg = configFromObject({});
    const oauth = (cfg.secrets as Record<string, unknown>).oauth as Record<string, Record<string, unknown>>;
    expect(oauth?.linear?.scopes).toEqual(["read", "write", "issues:create"]);
  });

  it("linear default row has correct tokenUrl", () => {
    const cfg = configFromObject({});
    const oauth = (cfg.secrets as Record<string, unknown>).oauth as Record<string, Record<string, unknown>>;
    expect(oauth?.linear?.tokenUrl).toBe("https://api.linear.app/oauth/token");
  });

  it("linear default row has correct authorizeUrl", () => {
    const cfg = configFromObject({});
    const oauth = (cfg.secrets as Record<string, unknown>).oauth as Record<string, Record<string, unknown>>;
    expect(oauth?.linear?.authorizeUrl).toBe("https://linear.app/oauth/authorize");
  });

  it("linear default row persists when loaded from YAML", () => {
    const p = writeConfig("auth-yaml-oauth.yaml", "secrets:\n  provider: env\n");
    const cfg = loadConfig(p);
    const oauth = (cfg.secrets as Record<string, unknown>).oauth as Record<string, Record<string, unknown>>;
    expect(oauth?.linear).toBeDefined();
    expect(oauth?.linear?.clientId).toBe("c22fe7e6dfa9be091c5ea19f6121307f");
  });
});

// ── superRefine validations ────────────────────────────────────────────────────

describe("config-auth — superRefine rejects bad oauth auth rows", () => {
  it("rejects secrets.auth row with type oauth and provider not in secrets.oauth", () => {
    const badConfig = {
      secrets: {
        provider: "env",
        auth: {
          MY_KEY: { type: "oauth", store: "claude-oauth", provider: "nope" },
        },
      },
    };
    expect(() => configFromObject(badConfig)).toThrow();
  });

  it("rejects secrets.auth row with type oauth and missing provider field", () => {
    const badConfig = {
      secrets: {
        provider: "env",
        auth: {
          MY_KEY: { type: "oauth", store: "claude-oauth" },
        },
      },
    };
    expect(() => configFromObject(badConfig)).toThrow();
  });

  it("rejects via loadConfig (YAML form) when provider is unknown", () => {
    const yaml = [
      "secrets:",
      "  provider: env",
      "  auth:",
      "    LINEAR_API_KEY:",
      "      type: oauth",
      "      store: claude-oauth",
      "      provider: nonexistent-provider",
    ].join("\n");
    const p = writeConfig("auth-bad-provider.yaml", yaml);
    expect(() => loadConfig(p)).toThrow();
  });

  it("accepts a valid oauth row whose provider IS in secrets.oauth", () => {
    // 'linear' is in the default secrets.oauth registry
    const goodConfig = {
      secrets: {
        provider: "env",
        auth: {
          LINEAR_API_KEY: { type: "oauth", store: "claude-oauth", provider: "linear" },
        },
      },
    };
    expect(() => configFromObject(goodConfig)).not.toThrow();
  });

  it("accepts a non-oauth auth row (no provider required for api-key type)", () => {
    const goodConfig = {
      secrets: {
        provider: "env",
        auth: {
          SOME_KEY: { type: "api-key" },
        },
      },
    };
    expect(() => configFromObject(goodConfig)).not.toThrow();
  });

  it("accepts an env-type auth row", () => {
    const goodConfig = {
      secrets: {
        provider: "env",
        auth: {
          SOME_ENV_KEY: { type: "env" },
        },
      },
    };
    expect(() => configFromObject(goodConfig)).not.toThrow();
  });

  it("the existing 1password superRefine still works alongside the new oauth superRefine", () => {
    // The existing WS-2 superRefine only fires for 1password provider;
    // here we verify both can coexist without interfering.
    const validConfig = {
      secrets: {
        provider: "1password",
        auth: {
          PERPLEXITY_API_KEY: { type: "api-key" },
        },
      },
    };
    // Should pass: 1password provider + valid services row + non-oauth auth row
    expect(() => configFromObject(validConfig)).not.toThrow();
  });
});
