/**
 * WS-E (gated) — OnePasswordProvider against the REAL `op` CLI.
 *
 * The offline unit test (`onepassword-provider.test.ts`) injects a fake
 * `OpRunner`, so the ONE production path it can never cover is
 * `defaultOpRunner` (onepassword-provider.ts:97-116) — the actual
 * `execFile("op", ["read", "--account", acct, ref])` subprocess. This file closes
 * that gap by constructing the provider with the DEFAULT runner (no injected fake)
 * and exercising the live binary. It is OPT-IN and SKIPS cleanly without creds, and
 * NEVER writes a secret to disk or into this source.
 *
 * SERVICE-AWARE contract (Option B): env vars now specify the full service row
 * coordinates (item, vault, field) so the provider can look them up in its
 * `services` map, build `op://vault/item/field`, and invoke
 * `op read --account <acct> <ref>`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO RUN IT (the O4 checklist the human must complete)
 *
 *   `op` itself must be authed before running — this test passes NO token; it
 *   relies on `op` already having a session:
 *     • Local (interactive):  op signin --account praetorianlabs
 *     • CI (service account):  export OP_SERVICE_ACCOUNT_TOKEN=<token>
 *                              (sourced from the GitHub Actions secret
 *                               ONE_PASS_SERVICE_ACCOUNT; consumed by `op`,
 *                               NOT by this test). Install `op` via the
 *                               SHA-pinned 1password/install-cli-action.
 *
 *   Env vars THIS test reads:
 *     OP_INTEGRATION=1              (REQUIRED) master opt-in switch.
 *     GATEWAY_OP_TEST_VAULT         (happy path) the vault holding the throwaway item.
 *     GATEWAY_OP_TEST_ITEM          (happy path) the 1Password ITEM TITLE (not key).
 *     GATEWAY_OP_TEST_AUTH_KEY      (happy path) the flat auth key (e.g. MY_TEST_KEY).
 *     GATEWAY_OP_TEST_FIELD         (optional)   field name; defaults to `password`.
 *     GATEWAY_OP_TEST_EXPECTED      (optional)   the known dummy value; if set the test
 *                                   asserts an EXACT match, else asserts a non-empty
 *                                   string. NEVER hardcode the secret here.
 *     OP_ACCOUNT                    (optional)   1Password account shorthand; defaults
 *                                   to praetorianlabs.1password.com.
 *
 *   Minimal happy-path invocation (after `op` is authed):
 *     OP_INTEGRATION=1 \
 *     GATEWAY_OP_TEST_VAULT=Engineering \
 *     GATEWAY_OP_TEST_ITEM="Gateway Throwaway Test" \
 *     GATEWAY_OP_TEST_AUTH_KEY=GATEWAY_THROWAWAY_KEY \
 *     GATEWAY_OP_TEST_EXPECTED=dummy-value-ok \
 *     npx vitest run test/onepassword.integration.test.ts
 *
 *   Failure-path only (proves ENOENT/non-zero mapping; needs NO vault item, only
 *   that `op` is installed — or, for the bogus-cliPath case, not even that):
 *     OP_INTEGRATION=1 npx vitest run test/onepassword.integration.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NB: `npm test` runs with NODE_OPTIONS=--no-node-snapshot (see package.json).
 */
import { describe, it, expect } from "vitest";
import { OnePasswordProvider } from "../src/secrets/onepassword-provider.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

/**
 * Real `op read` shells out to the 1Password backend, which can exceed vitest's
 * default 5s per-test timeout on a cold session / slow network.
 */
const OP_TIMEOUT_MS = 30_000;

/** Master opt-in: nothing in this file runs unless explicitly enabled. */
const OPT_IN = process.env.OP_INTEGRATION === "1";

const VAULT = process.env.GATEWAY_OP_TEST_VAULT;
const ITEM = process.env.GATEWAY_OP_TEST_ITEM;
const AUTH_KEY = process.env.GATEWAY_OP_TEST_AUTH_KEY;
const FIELD = process.env.GATEWAY_OP_TEST_FIELD ?? "password";
const EXPECTED = process.env.GATEWAY_OP_TEST_EXPECTED;

/** Account shorthand — falls back to the Praetorian default if not set. */
const ACCOUNT = process.env.OP_ACCOUNT ?? "praetorianlabs.1password.com";

/**
 * Happy path: real `op read --account <acct> op://vault/item/field` against a
 * real, human-provisioned throwaway item. Requires the opt-in switch AND the full
 * service coordinates (vault + item title + auth key).
 */
const HAPPY_ENABLED = OPT_IN && Boolean(VAULT) && Boolean(ITEM) && Boolean(AUTH_KEY);

describe.skipIf(!HAPPY_ENABLED)(
  "OnePasswordProvider — real `op` happy path (gated)",
  () => {
    it("resolves the throwaway item via the DEFAULT runner (real `op read --account ...`)", async () => {
      // Build a services map with the throwaway item's coordinates.
      // No injected runner → exercises defaultOpRunner / the live `op` subprocess.
      const services = {
        [AUTH_KEY as string]: {
          item: ITEM as string,
          vault: VAULT as string,
          field: FIELD,
        },
      };

      const provider = new OnePasswordProvider({
        vault: VAULT,
        account: ACCOUNT,
        field: FIELD,
        refTemplate: "op://{vault}/{item}/{field}",
        cliPath: "op",
        services,
      });

      const secrets = await provider.resolve([AUTH_KEY as string]);
      const value = secrets[AUTH_KEY as string];

      if (EXPECTED !== undefined) {
        // Known dummy value provided out-of-band — assert exact match.
        expect(value).toBe(EXPECTED);
      } else {
        // No expected value given — assert a real, non-empty credential came back.
        expect(typeof value).toBe("string");
        expect(value.length).toBeGreaterThan(0);
      }
    }, OP_TIMEOUT_MS);
  },
);

/**
 * Failure path — non-existent 1Password item against the REAL binary.
 *
 * Needs `op` installed + authed (so it can reach the backend and get a non-zero
 * "item not found" exit), but NOT the throwaway item. Gated on the opt-in switch
 * + a vault name so we have somewhere real to look (and miss).
 */
const MISSING_REF_ENABLED = OPT_IN && Boolean(VAULT);

describe.skipIf(!MISSING_REF_ENABLED)(
  "OnePasswordProvider — real `op` non-existent item (gated)",
  () => {
    it("maps a vault/item that does not exist to secret_backend_unavailable", async () => {
      const bogusKey = "GATEWAY_NONEXISTENT_ITEM_7F3A";
      const services = {
        [bogusKey]: {
          item: "gateway-nonexistent-item-7f3a-do-not-create",
          vault: VAULT as string,
        },
      };

      const provider = new OnePasswordProvider({
        vault: VAULT,
        account: ACCOUNT,
        field: FIELD,
        refTemplate: "op://{vault}/{item}/{field}",
        cliPath: "op",
        services,
      });

      try {
        await provider.resolve([bogusKey]);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(GatewayError);
        expect((e as GatewayError).code).toBe("secret_backend_unavailable");
      }
    }, OP_TIMEOUT_MS);
  },
);

/**
 * Failure path — bogus `cliPath` → ENOENT → secret_backend_unavailable.
 *
 * Proves the ENOENT branch of defaultOpRunner. Does NOT need a vault, a throwaway
 * item, or even a real `op` on PATH (the point is the named binary is absent).
 */
describe.skipIf(!OPT_IN)(
  "OnePasswordProvider — bogus cliPath ENOENT (gated on OP_INTEGRATION only)",
  () => {
    it("maps a missing op binary (ENOENT) to secret_backend_unavailable", async () => {
      const services = {
        ANY_KEY: { item: "Any Item", vault: "AnyVault" },
      };

      const provider = new OnePasswordProvider({
        vault: "AnyVault",
        account: ACCOUNT,
        field: "password",
        refTemplate: "op://{vault}/{item}/{field}",
        cliPath: "op-does-not-exist-xyz",
        services,
      });

      try {
        await provider.resolve(["ANY_KEY"]);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(GatewayError);
        expect((e as GatewayError).code).toBe("secret_backend_unavailable");
      }
    });
  },
);
