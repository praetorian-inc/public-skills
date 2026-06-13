/**
 * {@link SecretProvider} backed by the 1Password `op` CLI (D8).
 *
 * For each requested key it builds an `op://` reference from a configurable
 * template (default `op://{vault}/{key}/password`), invokes `op read "<ref>"`
 * via an INJECTED command runner, and returns the trimmed value.
 *
 * Failure taxonomy (mirrors {@link EnvProvider}'s shape — loop keys, build a
 * record, throw a coded error):
 *   - empty / whitespace-only value          → `missing_secret` (reuse P0 code;
 *     matches env-provider.ts:18 — an empty credential is never valid)
 *   - `op` absent (ENOENT), non-zero exit,
 *     or auth failure                        → `secret_backend_unavailable`
 *     (a clean coded error, NEVER a crash)
 *
 * Caching: each distinct key is resolved at most once per provider instance via
 * an in-memory Map (no TTL — process-lifetime; YAGNI), so a `run_code` program
 * making many capability calls does not shell out to `op` repeatedly.
 *
 * Security: secret VALUES are never logged and never appear in error messages —
 * errors name only the offending key (matching `missingSecret`), and backend
 * errors carry only the exit code / error name (never `op` stdout/stderr).
 */
import type { SecretProvider } from "./provider.js";
import { missingSecret, secretBackendUnavailable } from "../errors/to-tool-error.js";

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

/** The `secrets.onepassword` config slice this provider needs. */
export interface OnePasswordConfig {
  vault?: string;
  /** Template with `{vault}` + `{key}` placeholders. Default `op://{vault}/{key}/password`. */
  refTemplate: string;
  /** `op` binary path (allows overriding). Default `op`. */
  cliPath: string;
}

const DEFAULT_REF_TEMPLATE = "op://{vault}/{key}/password";
const DEFAULT_CLI_PATH = "op";

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
      vault: cfg?.vault,
      refTemplate: cfg?.refTemplate ?? DEFAULT_REF_TEMPLATE,
      cliPath: cfg?.cliPath ?? DEFAULT_CLI_PATH,
    };
    this.#run = run ?? defaultOpRunner(this.#cfg.cliPath);
  }

  async resolve(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const key of keys) {
      out[key] = await this.#resolveOne(key);
    }
    return out;
  }

  async #resolveOne(key: string): Promise<string> {
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const ref = this.#cfg.refTemplate
      .replaceAll("{vault}", this.#cfg.vault ?? "")
      .replaceAll("{key}", key);

    let result: OpRunResult;
    try {
      result = await this.#run(["read", ref]);
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
      throw missingSecret(key);
    }

    this.#cache.set(key, value);
    return value;
  }
}
