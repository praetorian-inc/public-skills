/**
 * {@link SecretProvider} backed by `process.env` (P0 default).
 *
 * Throws a `missing_secret` {@link GatewayError} — naming the offending key — for
 * any requested key that is absent or empty.
 */
import type { SecretProvider } from "./provider.js";
import { missingSecret } from "../errors/to-tool-error.js";

export class EnvProvider implements SecretProvider {
  async resolve(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const key of keys) {
      const value = process.env[key];
      // Treat undefined AND empty string as missing — an empty secret is never
      // a valid credential and silently passing "" would defer the failure to
      // the upstream call with a far worse error.
      if (value === undefined || value === "") {
        throw missingSecret(key);
      }
      out[key] = value;
    }
    return out;
  }
}
