/**
 * {@link SecretProvider} backed by `process.env` (P0 default).
 *
 * Throws a `missing_secret` {@link GatewayError} — naming the offending key — for
 * any requested key that is absent or empty.
 *
 * Routes each requested entry through the SHARED {@link parseAuthEntry} seam so
 * the auth contract is defined once across both providers. Under the current
 * (Option B) contract the entry IS the flat key, and the env-var fast-path name
 * defaults to that flat key — so `claude mcp add -e PERPLEXITY_API_KEY=...` keeps
 * resolving exactly as before (parser is identity-ish). The seam keeps the env
 * provider honest if a `service:logicalKey` contract is added later.
 */
import type { SecretProvider } from "./provider.js";
import { missingSecret } from "../errors/to-tool-error.js";
import { parseAuthEntry } from "./auth-entry.js";

export class EnvProvider implements SecretProvider {
  async resolve(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const key of keys) {
      const { flatKey } = parseAuthEntry(key);
      // Env-var fast-path: the var NAME defaults to the flat key (no per-service
      // env override is configured in the gateway port), preserving the existing
      // `process.env[FLAT_KEY]` behavior.
      const value = process.env[flatKey];
      // Treat undefined AND empty string as missing — an empty secret is never
      // a valid credential and silently passing "" would defer the failure to
      // the upstream call with a far worse error.
      if (value === undefined || value === "") {
        throw missingSecret(flatKey);
      }
      out[flatKey] = value;
    }
    return out;
  }
}
