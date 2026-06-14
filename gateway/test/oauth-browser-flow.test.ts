/**
 * T8 — createCallbackServer / runBrowserFlow (plan §2 C7, §5)
 *
 * Tests that:
 *   - createCallbackServer starts on an ephemeral test port
 *   - A real HTTP GET to /oauth/callback?code=c&state=s resolves
 *     waitForCallback() with {code:"c", state:"s"}
 *   - A request to another path returns 404
 *   - ?error=denied causes waitForCallback() to reject
 *   - runBrowserFlow with state mismatch → rejects with a CSRF error
 *   - Server is always cleaned up (close() in afterEach)
 *
 * Browser opener is INJECTED — no real browser launched.
 * No real Linear network.
 *
 * Imports from `src/secrets/oauth-browser-flow.ts` which does not exist yet
 * (RED phase).
 */
import { describe, it, expect, afterEach } from "vitest";
import { createCallbackServer, runBrowserFlow } from "../src/secrets/oauth-browser-flow.js";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";

// ── helpers ────────────────────────────────────────────────────────────────────

/** Pick an ephemeral port by binding to :0 briefly, then using that port in tests. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const { createServer } = require("node:http") as typeof import("node:http");
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Send an HTTP GET to localhost on the given port + path and return the response. */
async function httpGet(port: number, path: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// Track servers for cleanup
const serversToClose: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const s of serversToClose) {
    try { s.close(); } catch { /* already closed */ }
  }
  serversToClose.length = 0;
});

// ── createCallbackServer ───────────────────────────────────────────────────────

describe("createCallbackServer — happy path callback", () => {
  it("waitForCallback() resolves with {code, state} on a valid /oauth/callback GET", async () => {
    const port = await findFreePort();
    const { server, waitForCallback, close } = createCallbackServer(port);
    serversToClose.push({ close });

    // Fire the callback request in parallel with waiting
    const waitPromise = waitForCallback();
    // Small tick to ensure server is listening before we send the request
    await new Promise<void>((resolve) => server.once("listening", resolve).on("listening", resolve));

    // If already listening, the event may have fired. Fallback: just wait a tick.
    await new Promise((r) => setTimeout(r, 20));

    const getPromise = httpGet(port, "/oauth/callback?code=auth-code-xyz&state=state-abc");

    const [result] = await Promise.all([waitPromise, getPromise]);
    expect(result).toEqual({ code: "auth-code-xyz", state: "state-abc" });
  });

  it("HTTP response to /oauth/callback is 200 OK on success", async () => {
    const port = await findFreePort();
    const { waitForCallback, close } = createCallbackServer(port);
    serversToClose.push({ close });

    await new Promise((r) => setTimeout(r, 30));
    const [, response] = await Promise.all([
      waitForCallback().catch(() => {}), // may succeed or fail depending on state; we just need response
      httpGet(port, "/oauth/callback?code=c&state=s"),
    ]);
    expect(response.statusCode).toBe(200);
  });
});

describe("createCallbackServer — non-callback path returns 404", () => {
  it("GET /other returns 404", async () => {
    const port = await findFreePort();
    const { server: _server, waitForCallback: _wait, close } = createCallbackServer(port);
    serversToClose.push({ close });

    await new Promise((r) => setTimeout(r, 30));
    // Send to a non-callback path
    const response = await httpGet(port, "/other");
    expect(response.statusCode).toBe(404);
  });

  it("GET / (root) returns 404", async () => {
    const port = await findFreePort();
    const { close } = createCallbackServer(port);
    serversToClose.push({ close });

    await new Promise((r) => setTimeout(r, 30));
    const response = await httpGet(port, "/");
    expect(response.statusCode).toBe(404);
  });
});

describe("createCallbackServer — ?error param rejects waitForCallback", () => {
  it("?error=denied causes waitForCallback() to reject", async () => {
    const port = await findFreePort();
    const { waitForCallback, close } = createCallbackServer(port);
    serversToClose.push({ close });

    await new Promise((r) => setTimeout(r, 30));
    const [result] = await Promise.allSettled([
      waitForCallback(),
      httpGet(port, "/oauth/callback?error=access_denied"),
    ]);
    expect(result.status).toBe("rejected");
  });
});

// ── runBrowserFlow — CSRF state mismatch ──────────────────────────────────────

describe("runBrowserFlow — state mismatch → CSRF error", () => {
  it("rejects with a CSRF error when callback state does not match expected state", async () => {
    const port = await findFreePort();

    // Injected opener: captures the URL, then fires the callback with WRONG state
    const openBrowser = async (url: string) => {
      // Extract the correct state from the URL so we can send the WRONG one
      const parsed = new URL(url);
      const _correctState = parsed.searchParams.get("state") ?? "";
      // Wait a tick, then hit the callback with a mismatched state
      setTimeout(async () => {
        await httpGet(port, "/oauth/callback?code=c&state=WRONG_STATE").catch(() => {});
      }, 30);
    };

    await expect(
      runBrowserFlow("https://example.com/oauth/authorize?response_type=code&state=CORRECT_STATE", "CORRECT_STATE", {
        openBrowser,
        port,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/csrf/i);
  });

  it("CSRF rejection message contains 'CSRF' or 'state' or 'mismatch'", async () => {
    const port = await findFreePort();
    const openBrowser = async (_url: string) => {
      setTimeout(async () => {
        await httpGet(port, "/oauth/callback?code=c&state=WRONG").catch(() => {});
      }, 30);
    };

    try {
      await runBrowserFlow(
        "https://example.com/oauth/authorize?state=EXPECTED",
        "EXPECTED",
        { openBrowser, port, timeoutMs: 5000 },
      );
      throw new Error("should have rejected");
    } catch (e) {
      const msg = (e as Error).message.toLowerCase();
      const hasKeyword = msg.includes("csrf") || msg.includes("state") || msg.includes("mismatch");
      expect(hasKeyword).toBe(true);
    }
  });
});

// ── runBrowserFlow — injected opener is called ─────────────────────────────────

describe("runBrowserFlow — opener injection", () => {
  it("calls the injected openBrowser with the authorization URL", async () => {
    const port = await findFreePort();
    const openedUrls: string[] = [];

    const openBrowser = async (url: string) => {
      openedUrls.push(url);
      // Immediately simulate a successful callback with the correct state
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state") ?? "";
      setTimeout(async () => {
        await httpGet(port, `/oauth/callback?code=test-code&state=${encodeURIComponent(state)}`).catch(() => {});
      }, 30);
    };

    const authUrl = `https://example.com/oauth/authorize?response_type=code&state=correct-state`;
    await runBrowserFlow(authUrl, "correct-state", {
      openBrowser,
      port,
      timeoutMs: 5000,
    });

    expect(openedUrls).toHaveLength(1);
    expect(openedUrls[0]).toBe(authUrl);
  });

  it("returns the authorization code from the callback", async () => {
    const port = await findFreePort();

    const openBrowser = async (url: string) => {
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state") ?? "";
      setTimeout(async () => {
        await httpGet(port, `/oauth/callback?code=returned-code-42&state=${encodeURIComponent(state)}`).catch(() => {});
      }, 30);
    };

    const code = await runBrowserFlow(
      "https://example.com/authorize?state=st-123",
      "st-123",
      { openBrowser, port, timeoutMs: 5000 },
    );
    expect(code).toBe("returned-code-42");
  });
});
