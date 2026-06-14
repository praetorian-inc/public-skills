#!/usr/bin/env node
/**
 * Gateway auth CLI (plan §2 C11, §6 P-B).
 *
 * Usage:
 *   gateway-auth login <service>    PKCE → browser → exchange → store.save
 *   gateway-auth logout <service>   store.clear(service)
 *
 * A thin orchestration over the P-A building blocks (no logic duplicated):
 *   - {@link OAuthManager}   — PKCE, auth-URL build, code exchange (src/secrets/oauth-manager.ts)
 *   - {@link runBrowserFlow} — loopback callback + CSRF check (src/secrets/oauth-browser-flow.ts)
 *   - {@link ClaudeOAuthStore} — `~/.claude-oauth/<provider>.json` backend (src/secrets/token-store)
 *   - {@link DEFAULT_OAUTH_PROVIDERS} — the provider registry (src/secrets/oauth-config.ts)
 *
 * Every seam is injectable (AuthDeps) so tests drive the flow with NO real browser,
 * network, or HOME writes. `runAuth` returns a process exit code (0 ok, non-zero error).
 *
 * Secret hygiene: ALL output goes through `log` (default `console.error` — stderr;
 * stdout is reserved). Token values (access/refresh) are NEVER logged.
 */
import { OAuthManager } from "../secrets/oauth-manager.js";
import { runBrowserFlow as defaultRunBrowserFlow } from "../secrets/oauth-browser-flow.js";
import { ClaudeOAuthStore } from "../secrets/token-store/claude-oauth-store.js";
import {
  DEFAULT_OAUTH_PROVIDERS,
  OAuthProviderConfigSchema,
} from "../secrets/oauth-config.js";
import type { TokenStore } from "../secrets/token-store/token-store.js";

// Re-export so callers/tests can import the registry from this module (per the test contract).
export { DEFAULT_OAUTH_PROVIDERS } from "../secrets/oauth-config.js";

export interface AuthDeps {
  /** Token storage seam (default: ClaudeOAuthStore — the file store). */
  store: TokenStore;
  /** Browser flow seam; default = the real loopback/browser flow. */
  runBrowserFlow?: (url: string, state: string, d?: unknown) => Promise<string>;
  /** Injected for tests; defaults to the Node ≥ 20 global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected clock; defaults to `Date.now`. */
  now?: () => number;
  /** Provider registry; defaults to DEFAULT_OAUTH_PROVIDERS. */
  providers?: typeof DEFAULT_OAUTH_PROVIDERS;
  /** Output sink; defaults to stderr. NEVER receives token values. */
  log?: (msg: string) => void;
}

const USAGE = "Usage: gateway-auth <login|logout> <service>";

/**
 * Run the auth CLI for the given argv (already sliced past `node`/script).
 * Returns a process exit code: 0 on success, non-zero on any error.
 */
export async function runAuth(argv: string[], deps: AuthDeps): Promise<number> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const [subcommand, service] = argv;

  if (subcommand === "login") {
    return login(service, deps, log);
  }
  if (subcommand === "logout") {
    return logout(service, deps, log);
  }

  log(`Unknown command: ${subcommand ?? "(none)"}\n${USAGE}`);
  return 1;
}

async function login(
  service: string | undefined,
  deps: AuthDeps,
  log: (msg: string) => void,
): Promise<number> {
  if (!service) {
    log(`login requires a <service> argument.\n${USAGE}`);
    return 1;
  }

  const providers = deps.providers ?? DEFAULT_OAUTH_PROVIDERS;
  const row = (providers as Record<string, unknown>)[service];
  if (row === undefined) {
    log(`Unknown service: ${service}`);
    return 1;
  }

  const cfg = OAuthProviderConfigSchema.parse(row);
  const clientIdOverride = process.env[`${service.toUpperCase()}_CLIENT_ID`];
  const manager = new OAuthManager(service, cfg, {
    store: deps.store,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    clientIdOverride,
  });

  const pkce = manager.generatePKCE();
  const url = manager.buildAuthorizationUrl(pkce);
  const browserFlow = deps.runBrowserFlow ?? defaultRunBrowserFlow;

  const code = await browserFlow(url, pkce.state);
  // exchangeCodeForTokens saves via the store; we never log the returned tokens.
  await manager.exchangeCodeForTokens(code, pkce.codeVerifier);

  log(`Logged in to ${service}.`);
  return 0;
}

async function logout(
  service: string | undefined,
  deps: AuthDeps,
  log: (msg: string) => void,
): Promise<number> {
  if (!service) {
    log(`logout requires a <service> argument.\n${USAGE}`);
    return 1;
  }
  await deps.store.clear(service);
  log(`Logged out of ${service}.`);
  return 0;
}

/**
 * Detect direct script invocation (not import). When imported by tests,
 * `import.meta.url` !== the executed entry, so the CLI does NOT auto-run.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === new URL(`file://${entry}`).href;
}

if (isMainModule()) {
  const deps: AuthDeps = { store: new ClaudeOAuthStore() };
  runAuth(process.argv.slice(2), deps).then((code) => process.exit(code));
}
