/**
 * Gateway-local OAuth browser flow (plan §2 C7).
 *
 * Mirror of the SDK flow (`tools/claude-tool-sdk/src/oauth-browser-flow.ts:41-179`):
 * a loopback callback server on `/oauth/callback`, a browser open, a state/CSRF
 * check, and a 5-minute timeout. Two gateway-specific tightenings:
 *   - The browser opener is INJECTABLE (`deps.openBrowser`) so tests drive the
 *     callback without launching a real browser.
 *   - ALL progress/diagnostics go to `console.error` — the SDK uses `console.log`
 *     (oauth-browser-flow.ts:155-174) but in the gateway stdout is the MCP framing
 *     channel, so user-facing text MUST go to stderr.
 */
import { createServer, type Server } from "node:http";
import { parse as parseUrl } from "node:url";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Registered Linear callback port — do not change. */
const DEFAULT_PORT = 14881;
/** Authorization timeout (5 minutes). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServer {
  server: Server;
  waitForCallback: () => Promise<CallbackResult>;
  close: () => void;
}

export interface BrowserFlowDeps {
  /** Injected browser opener; default = platform `open` / `start` / `xdg-open`. */
  openBrowser?: (url: string) => Promise<void>;
  /** Callback server port; default 14881 (REGISTERED — do not change). */
  port?: number;
  /** Authorization timeout in ms; default 5 minutes. */
  timeoutMs?: number;
}

/**
 * Start a loopback callback server. `waitForCallback()` resolves on a valid
 * `/oauth/callback?code&state` GET, rejects on an `error` query, missing
 * code/state, and returns 404 for any other path.
 */
export function createCallbackServer(port: number): CallbackServer {
  let resolveCallback!: (result: CallbackResult) => void;
  let rejectCallback!: (error: Error) => void;

  const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    const parsed = parseUrl(req.url, true);

    if (parsed.pathname === "/oauth/callback") {
      const { code, state, error, error_description } = parsed.query;

      if (error) {
        res.writeHead(400);
        res.end("Authorization failed. You can close this window.");
        rejectCallback(new Error(`OAuth error: ${String(error)}`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400);
        res.end("Missing code or state");
        rejectCallback(new Error("Missing authorization code or state"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><h1>Authorization Successful</h1>
        <p>You can close this window and return to the terminal.</p>
        <script>setTimeout(() => window.close(), 2000);</script></body></html>`);

      resolveCallback({ code: String(code), state: String(state) });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, "127.0.0.1");

  return {
    server,
    waitForCallback: () => callbackPromise,
    close: () => server.close(),
  };
}

/** Open a URL in the default browser (platform-specific command). */
async function defaultOpenBrowser(url: string): Promise<void> {
  const platform = process.platform;
  let command: string;
  if (platform === "darwin") {
    command = `open "${url}"`;
  } else if (platform === "win32") {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  await execAsync(command);
}

/**
 * Run the browser authorization flow: start the loopback server, open the browser,
 * await the callback (with timeout), and verify the returned state against
 * `expectedState` (CSRF protection). Returns the authorization code. Always closes
 * the server. Throws on CSRF mismatch, timeout, or an OAuth `error` query.
 */
export async function runBrowserFlow(
  authorizationUrl: string,
  expectedState: string,
  deps?: BrowserFlowDeps,
): Promise<string> {
  const port = deps?.port ?? DEFAULT_PORT;
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const openBrowser = deps?.openBrowser ?? defaultOpenBrowser;

  const { waitForCallback, close } = createCallbackServer(port);

  try {
    // Progress → stderr (stdout is the MCP framing channel).
    console.error("\nOpening browser for authorization...");
    console.error("If the browser does not open, visit:");
    console.error(authorizationUrl);
    console.error("\nWaiting for authorization...\n");

    await openBrowser(authorizationUrl);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("Authorization timeout")),
        timeoutMs,
      );
    });

    try {
      const result = await Promise.race([waitForCallback(), timeoutPromise]);

      if (result.state !== expectedState) {
        throw new Error("CSRF state mismatch - possible attack");
      }

      console.error("Authorization successful.\n");
      return result.code;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  } finally {
    close();
  }
}
