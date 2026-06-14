/**
 * T9 — OAuth integration test (env-flag gated, plan §5 integration matrix)
 *
 * GATED on GATEWAY_OAUTH_INTEGRATION=1 — skips cleanly when the flag is unset.
 * Mirrors the skip-clean pattern of onepassword.integration.test.ts:29-47.
 *
 * Setup:
 *   - Creates a temp dir as the token store base dir
 *   - Seeds linear.json with expiresAt = now - 1 (expired) + a refreshToken
 *   - Starts a LOCAL mock HTTP server that returns a fresh token on POST
 *   - Points OAuthManager.tokenUrl (via the config row) at the local mock server
 *
 * Assertions:
 *   - Manager performs a refresh (calls the local mock server)
 *   - getValidAccessToken() returns the new accessToken
 *   - The store now holds the refreshed token
 *
 * Explicitly NOT tested here: real browser launch, real Linear token endpoint.
 *
 * Imports from:
 *   - `src/secrets/oauth-manager.ts` (C6) — does not exist yet (RED phase)
 *   - `src/secrets/token-store/claude-oauth-store.ts` (C3) — exists (Cycle 1)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { ClaudeOAuthStore } from "../src/secrets/token-store/claude-oauth-store.js";
import { OAuthManager } from "../src/secrets/oauth-manager.js";
import type { OAuthProviderConfig } from "../src/secrets/oauth-config.js";
import type { OAuthTokens } from "../src/secrets/oauth-tokens.js";

/** Master opt-in switch — mirrors onepassword.integration.test.ts:67. */
const OPT_IN = process.env.GATEWAY_OAUTH_INTEGRATION === "1";

// ── local mock HTTP server ─────────────────────────────────────────────────────

interface MockServer {
  port: number;
  close: () => Promise<void>;
}

/** Start a one-shot mock token endpoint that returns a fresh access token on POST. */
function startMockTokenServer(responseBody: object): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const close = () => new Promise<void>((r) => server.close(() => r()));
      resolve({ port, close });
    });
    server.on("error", reject);
  });
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe.skipIf(!OPT_IN)(
  "OAuthManager — near-expiry refresh against local mock server (gated GATEWAY_OAUTH_INTEGRATION=1)",
  () => {
    let tempDir: string;
    let mockServer: MockServer;
    const NEW_ACCESS_TOKEN = "refreshed-access-token-xyz";
    const OLD_REFRESH_TOKEN = "old-refresh-token-abc";

    beforeEach(async () => {
      // 1. Create isolated temp dir for the token store
      tempDir = mkdtempSync(join(tmpdir(), "gw-oauth-int-"));
      mkdirSync(tempDir, { recursive: true, mode: 0o700 });

      // 2. Seed linear.json with an expired token + refreshToken
      const expiredTokens: OAuthTokens = {
        provider: "linear",
        accessToken: "expired-old-access-token",
        refreshToken: OLD_REFRESH_TOKEN,
        expiresAt: Date.now() - 1, // already expired
        scopes: ["read", "write", "issues:create"],
        createdAt: Date.now() - 86_400_000, // 1 day ago
      };
      writeFileSync(
        join(tempDir, "linear.json"),
        JSON.stringify(expiredTokens, null, 2),
        { mode: 0o600 },
      );

      // 3. Start local mock token server that returns a fresh token
      mockServer = await startMockTokenServer({
        access_token: NEW_ACCESS_TOKEN,
        refresh_token: "new-refresh-token-xyz",
        expires_in: 3600,
      });
    });

    afterEach(async () => {
      await mockServer.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("getValidAccessToken() triggers a refresh and returns the new accessToken", async () => {
      const store = new ClaudeOAuthStore({ dir: tempDir });

      // Point tokenUrl at the local mock server
      const cfg: OAuthProviderConfig = {
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenUrl: `http://127.0.0.1:${mockServer.port}/oauth/token`,
        clientId: "c22fe7e6dfa9be091c5ea19f6121307f",
        pkce: true,
        scopes: ["read", "write", "issues:create"],
        actor: "user",
        redirect: "http://localhost:14881/oauth/callback",
        header: "Bearer {token}",
      };

      const mgr = new OAuthManager("linear", cfg, { store });

      // Should detect expired token, use refreshToken, call mock server, return new token
      const accessToken = await mgr.getValidAccessToken();
      expect(accessToken).toBe(NEW_ACCESS_TOKEN);
    });

    it("store holds the refreshed token after getValidAccessToken()", async () => {
      const store = new ClaudeOAuthStore({ dir: tempDir });

      const cfg: OAuthProviderConfig = {
        authorizeUrl: "https://linear.app/oauth/authorize",
        tokenUrl: `http://127.0.0.1:${mockServer.port}/oauth/token`,
        clientId: "c22fe7e6dfa9be091c5ea19f6121307f",
        pkce: true,
        scopes: ["read", "write", "issues:create"],
        actor: "user",
        redirect: "http://localhost:14881/oauth/callback",
        header: "Bearer {token}",
      };

      const mgr = new OAuthManager("linear", cfg, { store });
      await mgr.getValidAccessToken();

      // Verify the store now contains the new token
      const saved = await store.load("linear");
      expect(saved).not.toBeNull();
      expect(saved?.accessToken).toBe(NEW_ACCESS_TOKEN);
    });

    it("refresh request uses the old refreshToken as grant", async () => {
      // Track what the mock server received
      const receivedBodies: string[] = [];
      await mockServer.close();

      // Restart mock server with body capture
      const capturingServer: Server = createServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => { body += c.toString(); });
        req.on("end", () => {
          receivedBodies.push(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            access_token: NEW_ACCESS_TOKEN,
            expires_in: 3600,
          }));
        });
      });

      const serverPort = await new Promise<number>((resolve, reject) => {
        capturingServer.listen(0, "127.0.0.1", () => {
          const addr = capturingServer.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
        capturingServer.on("error", reject);
      });

      try {
        const store = new ClaudeOAuthStore({ dir: tempDir });
        const cfg: OAuthProviderConfig = {
          authorizeUrl: "https://linear.app/oauth/authorize",
          tokenUrl: `http://127.0.0.1:${serverPort}/oauth/token`,
          clientId: "c22fe7e6dfa9be091c5ea19f6121307f",
          pkce: true,
          scopes: ["read", "write", "issues:create"],
          actor: "user",
          redirect: "http://localhost:14881/oauth/callback",
          header: "Bearer {token}",
        };

        const mgr = new OAuthManager("linear", cfg, { store });
        await mgr.getValidAccessToken();

        // The body should contain grant_type=refresh_token and the old refresh token
        expect(receivedBodies).toHaveLength(1);
        const body = new URLSearchParams(receivedBodies[0]);
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe(OLD_REFRESH_TOKEN);
      } finally {
        await new Promise<void>((r) => capturingServer.close(() => r()));
      }
    });
  },
);
