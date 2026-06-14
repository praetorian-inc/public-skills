/**
 * Shared auth-entry parser — the SINGLE place the secret `auth` contract is
 * interpreted (plan §6).
 *
 * Both {@link EnvProvider} and {@link OnePasswordProvider} route every requested
 * `auth` entry through {@link parseAuthEntry}, so the flat-key↔service mapping is
 * defined once. Under the current (Option B) contract an auth entry IS the flat
 * key (e.g. `"PERPLEXITY_API_KEY"`); the service map in
 * {@link "../config".GatewayConfig} is indexed by that flat key. Parsing is
 * therefore an identity-ish normalize (trim) that returns the flat key.
 *
 * Keeping this as its own seam is deliberate: a future `service:logicalKey`
 * contract (Option A) becomes a localized change here plus a config lookup —
 * not a provider rewrite. Per KISS/YAGNI we do NOT build a grammar for a syntax
 * we are not adopting yet; this normalizes and returns the key.
 */

/** The interpreted form of a single `auth` entry. */
export interface ParsedAuthEntry {
  /**
   * The flat key used to index `secrets.onepassword.services` and (by default)
   * the env-var fast-path name. Under Option B this is the auth entry itself.
   */
  flatKey: string;
}

/**
 * Interpret one declared `auth` entry.
 *
 * Option B: the entry already IS the flat key; this trims surrounding whitespace
 * and returns it. (Option A later: parse a `service:logicalKey` form and resolve
 * service→flatKey here.)
 *
 * @param entry - a single string from a tool descriptor's `auth` array.
 * @returns the parsed entry carrying its `flatKey`.
 */
export function parseAuthEntry(entry: string): ParsedAuthEntry {
  return { flatKey: entry.trim() };
}
