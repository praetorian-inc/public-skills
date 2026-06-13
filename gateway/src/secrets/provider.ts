/**
 * Secret resolution contract.
 *
 * A {@link SecretProvider} maps a list of declared secret keys (a tool's `auth`)
 * to their values, resolved host-side. P0 ships {@link EnvProvider}; a 1Password
 * provider follows in P1. Handlers never read secrets directly — they receive
 * the resolved record via `ExecContext.secrets`.
 */
export interface SecretProvider {
  /**
   * Resolve every key in `keys` to its value.
   *
   * @throws if any key cannot be resolved (a `missing_secret` GatewayError).
   */
  resolve(keys: string[]): Promise<Record<string, string>>;
}
