/**
 * Default OAuth token backend: `~/.claude-oauth/<provider>.json` (plan §2 C3).
 *
 * Mirrors the SDK file store exactly (`tools/claude-tool-sdk/src/oauth-manager.ts:95-146`):
 *   - path  = join(dir ?? ~/.claude-oauth, `${provider}.json`)
 *   - dir   created with mode 0o700 if absent
 *   - file  chmod 0o600 after write
 *   - load  = readFile → JSON.parse → OAuthTokensSchema.parse; ANY throw ⇒ null
 *   - clear = unlink if exists (idempotent)
 *
 * The `dir` option is the test seam: tests inject a temp dir so no real HOME is
 * touched. SDK-compatible JSON (`JSON.stringify(tokens, null, 2)`) keeps tokens
 * interoperable with the core-plugin.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OAuthTokensSchema, type OAuthTokens } from "../oauth-tokens.js";
import type { TokenStore } from "./token-store.js";

export interface ClaudeOAuthStoreOpts {
  /** Override the base dir (tests inject a temp HOME-style dir). Default ~/.claude-oauth. */
  dir?: string;
}

export class ClaudeOAuthStore implements TokenStore {
  private readonly dir: string;

  constructor(opts?: ClaudeOAuthStoreOpts) {
    this.dir = opts?.dir ?? join(homedir(), ".claude-oauth");
  }

  private pathFor(provider: string): string {
    return join(this.dir, `${provider}.json`);
  }

  async load(provider: string): Promise<OAuthTokens | null> {
    const path = this.pathFor(provider);
    try {
      const content = readFileSync(path, "utf8");
      const parsed = JSON.parse(content);
      return OAuthTokensSchema.parse(parsed);
    } catch {
      // Absent, unreadable, non-JSON, or schema-mismatched ⇒ no usable credential.
      return null;
    }
  }

  async save(provider: string, tokens: OAuthTokens): Promise<void> {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
    const path = this.pathFor(provider);
    writeFileSync(path, JSON.stringify(tokens, null, 2), "utf8");
    chmodSync(path, 0o600);
  }

  async clear(provider: string): Promise<void> {
    const path = this.pathFor(provider);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}
