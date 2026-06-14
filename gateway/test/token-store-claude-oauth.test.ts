/**
 * T2 — ClaudeOAuthStore
 *
 * Tests that:
 *   - save→load round-trips tokens correctly
 *   - load returns null when the file is absent
 *   - load returns null when the file contains corrupt JSON
 *   - clear removes the token file (idempotent: second clear does not throw)
 *   - saved file has mode 0o600 (owner read+write only)
 *   - base dir has mode 0o700 (owner full, no group/other access)
 *
 * Uses a temp dir injected via ClaudeOAuthStoreOpts.dir (the seam defined in C3).
 * No real HOME is touched; cleanup is done in afterEach.
 *
 * Imports from `src/secrets/token-store/claude-oauth-store.ts` which does not
 * exist yet (RED phase).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeOAuthStore } from "../src/secrets/token-store/claude-oauth-store.js";

/** A minimal valid OAuthTokens object (all required fields, no optionals). */
const SAMPLE_TOKENS = {
  provider: "linear",
  accessToken: "at-test-12345",
  expiresAt: Date.now() + 3_600_000,
  scopes: ["read", "write"],
  createdAt: Date.now(),
};

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "gw-oauth-store-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ClaudeOAuthStore — happy path", () => {
  it("save then load round-trips all required fields", async () => {
    const store = new ClaudeOAuthStore({ dir: tempDir });
    await store.save("linear", SAMPLE_TOKENS);
    const loaded = await store.load("linear");
    expect(loaded).not.toBeNull();
    expect(loaded?.provider).toBe(SAMPLE_TOKENS.provider);
    expect(loaded?.accessToken).toBe(SAMPLE_TOKENS.accessToken);
    expect(loaded?.expiresAt).toBe(SAMPLE_TOKENS.expiresAt);
    expect(loaded?.scopes).toEqual(SAMPLE_TOKENS.scopes);
    expect(loaded?.createdAt).toBe(SAMPLE_TOKENS.createdAt);
  });

  it("round-trips optional refreshToken field", async () => {
    const store = new ClaudeOAuthStore({ dir: tempDir });
    const withRefresh = { ...SAMPLE_TOKENS, refreshToken: "rt-round-trip" };
    await store.save("linear", withRefresh);
    const loaded = await store.load("linear");
    expect(loaded?.refreshToken).toBe("rt-round-trip");
  });

  it("round-trips optional lastRefreshedAt field", async () => {
    const store = new ClaudeOAuthStore({ dir: tempDir });
    const ts = Date.now() - 1000;
    const withLastRefresh = { ...SAMPLE_TOKENS, lastRefreshedAt: ts };
    await store.save("linear", withLastRefresh);
    const loaded = await store.load("linear");
    expect(loaded?.lastRefreshedAt).toBe(ts);
  });

  it("overwrites existing tokens on second save", async () => {
    const store = new ClaudeOAuthStore({ dir: tempDir });
    await store.save("linear", SAMPLE_TOKENS);
    const updated = { ...SAMPLE_TOKENS, accessToken: "at-updated" };
    await store.save("linear", updated);
    const loaded = await store.load("linear");
    expect(loaded?.accessToken).toBe("at-updated");
  });
});

describe("ClaudeOAuthStore — file permissions", () => {
  it("saved token file has mode 0o600", async () => {
    const store = new ClaudeOAuthStore({ dir: tempDir });
    await store.save("linear", SAMPLE_TOKENS);
    // The file lives at <dir>/linear.json
    const filePath = join(tempDir, "linear.json");
    const stat = statSync(filePath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("base dir (injected via opts.dir) has mode 0o700 after save", async () => {
    // Use a fresh sub-directory that the store creates itself
    const storeDir = join(tempDir, "oauth-created");
    const store = new ClaudeOAuthStore({ dir: storeDir });
    await store.save("linear", SAMPLE_TOKENS);
    const stat = statSync(storeDir);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe("ClaudeOAuthStore — absent / corrupt file", () => {
  it("load returns null when no token file exists", async () => {
    const store = new ClaudeOAuthStore({ dir: tempDir });
    const result = await store.load("nonexistent-provider");
    expect(result).toBeNull();
  });

  it("load returns null for corrupt JSON", async () => {
    // Write a corrupt JSON file into the store directory
    mkdirSync(tempDir, { recursive: true });
    const corruptPath = join(tempDir, "corrupt.json");
    writeFileSync(corruptPath, "{ this is not valid json }", "utf8");
    const store = new ClaudeOAuthStore({ dir: tempDir });
    const result = await store.load("corrupt");
    expect(result).toBeNull();
  });

  it("load returns null for an empty file", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "empty.json"), "", "utf8");
    const store = new ClaudeOAuthStore({ dir: tempDir });
    const result = await store.load("empty");
    expect(result).toBeNull();
  });

  it("load returns null for JSON that does not match the schema (missing accessToken)", async () => {
    mkdirSync(tempDir, { recursive: true });
    // Valid JSON but missing required fields
    const badTokens = { provider: "linear", expiresAt: 1234 };
    writeFileSync(join(tempDir, "badschema.json"), JSON.stringify(badTokens), "utf8");
    const store = new ClaudeOAuthStore({ dir: tempDir });
    const result = await store.load("badschema");
    expect(result).toBeNull();
  });
});

describe("ClaudeOAuthStore — clear", () => {
  it("clear removes the token file", async () => {
    const store = new ClaudeOAuthStore({ dir: tempDir });
    await store.save("linear", SAMPLE_TOKENS);
    const filePath = join(tempDir, "linear.json");
    // Confirm file exists before clear
    expect(existsSync(filePath)).toBe(true);
    await store.clear("linear");
    expect(existsSync(filePath)).toBe(false);
  });

  it("clear is idempotent — calling it twice does not throw", async () => {
    const store = new ClaudeOAuthStore({ dir: tempDir });
    await store.save("linear", SAMPLE_TOKENS);
    await store.clear("linear");
    // Second clear on already-absent file should not throw
    await expect(store.clear("linear")).resolves.not.toThrow();
  });

  it("load returns null after clear", async () => {
    const store = new ClaudeOAuthStore({ dir: tempDir });
    await store.save("linear", SAMPLE_TOKENS);
    await store.clear("linear");
    const result = await store.load("linear");
    expect(result).toBeNull();
  });

  it("clear on a provider that was never saved does not throw", async () => {
    const store = new ClaudeOAuthStore({ dir: tempDir });
    await expect(store.clear("never-saved")).resolves.not.toThrow();
  });
});

describe("ClaudeOAuthStore — default dir behavior", () => {
  it("constructs without options (uses default ~/.claude-oauth path)", () => {
    // Just verify construction does not throw; we do NOT write to HOME
    expect(() => new ClaudeOAuthStore()).not.toThrow();
    expect(() => new ClaudeOAuthStore({})).not.toThrow();
  });
});
