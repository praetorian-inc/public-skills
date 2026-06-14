/**
 * {@link SecretProvider} backed by the 1Password `op` CLI (D8).
 *
 * SERVICE-AWARE resolution (Option B): each requested entry is a FLAT KEY (e.g.
 * `PERPLEXITY_API_KEY`). The provider looks the flat key up in the `services`
 * map → `{item, vault, field}`, builds an `op://{vault}/{item}/{field}` reference
 * from a configurable template, and invokes `op read --account "<acct>" "<ref>"`
 * via an INJECTED command runner, returning the trimmed value. This honors
 * Praetorian's existing 1Password layout (multiple vaults, named items, a named
 * account) without touching wrappers.
 *
 * Headless / service-account auth is handled implicitly by `op` itself: when
 * `OP_SERVICE_ACCOUNT_TOKEN` is present in the environment `op` runs headless,
 * otherwise it prompts biometric. The provider does nothing special except pass
 * `--account` — it never reads or manages the token (secrets never live here).
 *
 * Failure taxonomy (mirrors {@link EnvProvider}'s shape — loop keys, build a
 * record, throw a coded error):
 *   - flat key not in `services` map          → `config_invalid` (a wrapper
 *     declared a key the operator never mapped; names only the key)
 *   - empty / whitespace-only value           → `missing_secret` (reuse P0 code;
 *     matches env-provider.ts:18 — an empty credential is never valid)
 *   - `op` absent (ENOENT), non-zero exit,
 *     or auth failure                         → `secret_backend_unavailable`
 *     (a clean coded error, NEVER a crash)
 *
 * Caching: each distinct flat key is resolved at most once per provider instance
 * via an in-memory Map (no TTL — process-lifetime; YAGNI), so a `run_code`
 * program making many capability calls does not shell out to `op` repeatedly.
 *
 * Security: secret VALUES are never logged and never appear in error messages —
 * errors name only the offending key/service (matching `missingSecret`), and
 * backend errors carry only the exit code / error name (never `op`
 * stdout/stderr). `op` is invoked via `execFile` with an args array (no shell),
 * so the `op://` ref and `--account` value cannot be interpreted as shell syntax.
 */
import type { SecretProvider } from "./provider.js";
import { missingSecret, secretBackendUnavailable, configInvalid } from "../errors/to-tool-error.js";
import { parseAuthEntry } from "./auth-entry.js";

/** Result of running the `op` binary. */
export interface OpRunResult {
  /** Process exit code (0 = success). */
  code: number;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
}

/**
 * Runs the `op` CLI with `args` and resolves with its exit code + output.
 *
 * Injected so tests never shell out. A missing binary surfaces as a rejected
 * Promise (e.g. an `ENOENT` error) rather than a non-zero exit.
 */
export type OpRunner = (args: string[]) => Promise<OpRunResult>;

/** A single service row in the {@link OnePasswordConfig.services} map. */
export interface ServiceItem {
  /** Logical service name — informational only; the lookup key is the flat key. */
  service?: string;
  /** 1Password item title (required). */
  item: string;
  /** Per-service vault; falls back to {@link OnePasswordConfig.vault}. */
  vault?: string;
  /** Per-service field; falls back to {@link OnePasswordConfig.field}. */
  field?: string;
}

/** The `secrets.onepassword` config slice this provider needs. */
export interface OnePasswordConfig {
  /** 1Password account shorthand passed as `op --account`. Default ported below. */
  account: string;
  /** Default vault (per-service `vault` overrides; `OP_VAULT_NAME` overrides this). */
  vault?: string;
  /** Default field within an item (per-service `field` overrides). */
  field: string;
  /** Template with `{vault}` + `{item}` + `{field}` placeholders. Default `op://{vault}/{item}/{field}`. */
  refTemplate: string;
  /** `op` binary path (allows overriding). Default `op`. */
  cliPath: string;
  /** Service map keyed by FLAT KEY → 1Password coordinates. */
  services: Record<string, ServiceItem>;
}

const DEFAULT_REF_TEMPLATE = "op://{vault}/{item}/{field}";
const DEFAULT_CLI_PATH = "op";
const DEFAULT_ACCOUNT = "praetorianlabs.1password.com";
const DEFAULT_FIELD = "password";

/**
 * Default {@link OpRunner} that shells out to the real `op` binary via
 * `node:child_process`. Used only in the production path (tests inject a fake).
 * Lazy-imports `node:child_process` so importing this module is side-effect free.
 */
export function defaultOpRunner(cliPath: string): OpRunner {
  return async (args: string[]): Promise<OpRunResult> => {
    const { execFile } = await import("node:child_process");
    return new Promise<OpRunResult>((resolve, reject) => {
      execFile(cliPath, args, { encoding: "utf8" }, (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          // Binary not found — reject so the provider maps it to
          // secret_backend_unavailable instead of a misleading non-zero exit.
          reject(error);
          return;
        }
        // A non-zero exit also populates `error`; surface the numeric exit code
        // so the provider can distinguish backend failure from a found-but-empty
        // value. `error.code` here is the process exit code (a number).
        const code = error ? Number((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
    });
  };
}

export class OnePasswordProvider implements SecretProvider {
  readonly #cfg: OnePasswordConfig;
  readonly #run: OpRunner;
  readonly #cache = new Map<string, string>();

  /**
   * @param cfg - the `secrets.onepassword` config (optional; sensible defaults
   *   are applied when omitted so the provider works with a bare `{}` or
   *   `undefined`).
   * @param run - injected `op` runner; defaults to the real `op` binary.
   */
  constructor(cfg?: Partial<OnePasswordConfig>, run?: OpRunner) {
    this.#cfg = {
      account: cfg?.account ?? DEFAULT_ACCOUNT,
      vault: cfg?.vault,
      field: cfg?.field ?? DEFAULT_FIELD,
      refTemplate: cfg?.refTemplate ?? DEFAULT_REF_TEMPLATE,
      cliPath: cfg?.cliPath ?? DEFAULT_CLI_PATH,
      services: cfg?.services ?? {},
    };
    this.#run = run ?? defaultOpRunner(this.#cfg.cliPath);
  }

  async resolve(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const key of keys) {
      const { flatKey } = parseAuthEntry(key);
      // Keep the resolved-record key shape = the flat auth key, so handlers keep
      // reading `ctx.secrets.PERPLEXITY_API_KEY` unchanged (plan §7).
      out[flatKey] = await this.#resolveOne(flatKey);
    }
    return out;
  }

  async #resolveOne(flatKey: string): Promise<string> {
    const cached = this.#cache.get(flatKey);
    if (cached !== undefined) {
      return cached;
    }

    // Service lookup. An unmapped key is a wrapper declaring a key the operator
    // never mapped — fail loud with config_invalid, naming ONLY the key.
    const row = this.#cfg.services[flatKey];
    if (row === undefined) {
      throw configInvalid(`no 1Password service mapping for auth key "${flatKey}"`);
    }

    // Resolve coordinates. Precedence (plan §3):
    //   vault:   per-service > OP_VAULT_NAME env > config default vault
    //   field:   per-service > config default field
    //   account: OP_ACCOUNT env > config account
    const vault = row.vault ?? process.env.OP_VAULT_NAME ?? this.#cfg.vault ?? "";
    const field = row.field ?? this.#cfg.field;
    const account = process.env.OP_ACCOUNT ?? this.#cfg.account;

    const ref = this.#cfg.refTemplate
      .replaceAll("{vault}", vault)
      .replaceAll("{item}", row.item)
      .replaceAll("{field}", field);

    let result: OpRunResult;
    try {
      // `--account` added to the args array (vs the previous `["read", ref]`).
      // The OpRunner injection seam is intact — tests inject a fake runner and
      // assert these args. `op` honors OP_SERVICE_ACCOUNT_TOKEN implicitly.
      result = await this.#run(["read", "--account", account, ref]);
    } catch (e) {
      // ENOENT (binary missing) or any runner rejection — backend is down.
      // Only the error's code/name is surfaced, NEVER any secret value.
      const reason = (e as NodeJS.ErrnoException)?.code ?? "op invocation failed";
      throw secretBackendUnavailable(`op (${this.#cfg.cliPath}): ${reason}`);
    }

    if (result.code !== 0) {
      // Non-zero exit = not signed in, vault/item not found, etc. Surface the
      // backend failure WITHOUT echoing stdout/stderr (they may contain values).
      throw secretBackendUnavailable(`op exited ${result.code}`);
    }

    const value = result.stdout.trim();
    if (value === "") {
      // Found-but-empty is a missing credential, not a backend failure.
      throw missingSecret(flatKey);
    }

    this.#cache.set(flatKey, value);
    return value;
  }
}
