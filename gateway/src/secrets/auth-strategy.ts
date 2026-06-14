/**
 * Per-flat-key auth strategy resolution (plan §2 C9).
 *
 * `resolveStrategy` maps one flat key to the strategy used to resolve it. A key
 * ABSENT from `secrets.auth` defaults to `{ type: "api-key", store: <global> }`
 * — exactly today's behavior (the global env/1password provider). The config
 * `superRefine` (M1) is the primary guard for malformed oauth rows; this resolver
 * re-asserts the provider invariant defensively (`config_invalid`).
 */
import { configInvalid } from "../errors/to-tool-error.js";

/** Storage backend selectable for an oauth strategy. */
export type AuthStore = "claude-oauth" | "1password";

/** The active global provider kind (the existing `secrets.provider`). */
export type GlobalProviderKind = "env" | "1password";

/** Resolved strategy for one flat key. */
export type AuthStrategy =
  | { type: "env" }
  | { type: "api-key"; store: GlobalProviderKind } // store = the global provider
  | { type: "oauth"; store: AuthStore; provider: string };

/** A raw `secrets.auth.<flatKey>` row as parsed by the config schema (M1). */
export interface RawAuthRow {
  type: "env" | "api-key" | "oauth";
  store?: AuthStore;
  provider?: string;
}

/** A map of flat key → raw auth row, i.e. `secrets.auth`. */
export type AuthMap = Record<string, RawAuthRow>;

/**
 * Resolve the strategy for one flat key.
 *
 * @param flatKey - the declared auth key (e.g. `LINEAR_API_KEY`).
 * @param authMap - `secrets.auth`, or undefined when no map is configured.
 * @param globalProvider - the active `secrets.provider` (env | 1password).
 * @returns the strategy. Absent key ⇒ `{ type: "api-key", store: globalProvider }`.
 * @throws {@link GatewayError} (`config_invalid`) if an oauth row lacks a provider
 *   (defensive — config superRefine M1 is the primary guard).
 */
export function resolveStrategy(
  flatKey: string,
  authMap: AuthMap | undefined,
  globalProvider: GlobalProviderKind,
): AuthStrategy {
  const row = authMap?.[flatKey];
  if (row === undefined) {
    // Today's default path: the global provider as an api-key.
    return { type: "api-key", store: globalProvider };
  }
  switch (row.type) {
    case "env":
      return { type: "env" };
    case "api-key":
      // store mirrors the global provider (the api-key still comes from env/1password).
      return { type: "api-key", store: globalProvider };
    case "oauth":
      if (!row.provider) {
        throw configInvalid(`secrets.auth.${flatKey}.provider is required when type is "oauth"`);
      }
      return { type: "oauth", store: row.store ?? "claude-oauth", provider: row.provider };
    default:
      // Exhaustive — the config enum cannot produce another value.
      throw configInvalid(`secrets.auth.${flatKey}.type is invalid`);
  }
}
