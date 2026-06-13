/**
 * WS-E (gated) — OnePasswordProvider against the REAL `op` CLI.
 *
 * The offline unit test (`onepassword-provider.test.ts`) injects a fake
 * `OpRunner`, so the ONE production path it can never cover is
 * `defaultOpRunner` (onepassword-provider.ts:62-81) — the actual
 * `execFile("op", ["read", <ref>])` subprocess. This file closes that gap by
 * constructing the provider with the DEFAULT runner (no injected fake) and
 * exercising the live binary. It is OPT-IN and SKIPS cleanly without creds, and
 * NEVER writes a secret to disk or into this source.
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
 *     OP_INTEGRATION=1            (REQUIRED) master opt-in switch. Without it the
 *                                 entire file skips green.
 *     GATEWAY_OP_TEST_VAULT       (happy path) the vault holding the throwaway item.
 *     GATEWAY_OP_TEST_ITEM_KEY    (happy path) the key the human created — substituted
 *                                 for {key} in the ref template.
 *     GATEWAY_OP_TEST_FIELD       (optional)   field name; defaults to `password`
 *                                 (the provider's default ref template field).
 *     GATEWAY_OP_TEST_EXPECTED    (optional)   the known dummy value; if set the test
 *                                 asserts an EXACT match, else asserts a non-empty
 *                                 string. NEVER hardcode the secret here.
 *
 *   Minimal happy-path invocation (after `op` is authed):
 *     OP_INTEGRATION=1 \
 *     GATEWAY_OP_TEST_VAULT=Engineering \
 *     GATEWAY_OP_TEST_ITEM_KEY=gateway-throwaway-test \
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
 * default 5s per-test timeout on a cold session / slow network. The two tests
 * that invoke the real binary use this generous timeout; the ENOENT test (no
 * real binary) does not need it but is harmless to bound.
 */
const OP_TIMEOUT_MS = 30_000;

/** Master opt-in: nothing in this file runs unless explicitly enabled. */
const OPT_IN = process.env.OP_INTEGRATION === "1";

const VAULT = process.env.GATEWAY_OP_TEST_VAULT;
const ITEM_KEY = process.env.GATEWAY_OP_TEST_ITEM_KEY;
const FIELD = process.env.GATEWAY_OP_TEST_FIELD ?? "password";
const EXPECTED = process.env.GATEWAY_OP_TEST_EXPECTED;

/** Default provider ref template, with the (optional) field override. */
const REF_TEMPLATE = `op://{vault}/{key}/${FIELD}`;

/**
 * Happy path: real `op read` against a real, human-provisioned throwaway item.
 * Requires the opt-in switch AND the vault coordinates (the human's O4 step).
 */
const HAPPY_ENABLED = OPT_IN && Boolean(VAULT) && Boolean(ITEM_KEY);

describe.skipIf(!HAPPY_ENABLED)(
  "OnePasswordProvider — real `op` happy path (gated)",
  () => {
    it("resolves the throwaway item via the DEFAULT runner (real `op read`)", async () => {
      // No injected runner → exercises defaultOpRunner / the live `op` subprocess.
      const provider = new OnePasswordProvider({
        vault: VAULT,
        refTemplate: REF_TEMPLATE,
        cliPath: "op",
      });

      const secrets = await provider.resolve([ITEM_KEY as string]);
      const value = secrets[ITEM_KEY as string];

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
 * Failure path — non-existent `op://` ref against the REAL binary.
 *
 * Needs `op` installed + authed (so it can actually reach the backend and get a
 * non-zero "item not found" exit), but NOT the throwaway item. Gated on the
 * opt-in switch + a vault name so we have somewhere real to look (and miss).
 */
const MISSING_REF_ENABLED = OPT_IN && Boolean(VAULT);

describe.skipIf(!MISSING_REF_ENABLED)(
  "OnePasswordProvider — real `op` non-existent ref (gated)",
  () => {
    it("maps a vault/item that does not exist to secret_backend_unavailable", async () => {
      const provider = new OnePasswordProvider({
        vault: VAULT,
        refTemplate: REF_TEMPLATE,
        cliPath: "op",
      });

      // A key that (almost certainly) names no item → real `op` exits non-zero.
      const bogusKey = "gateway-nonexistent-item-7f3a-do-not-create";
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
 * This proves the ENOENT branch of defaultOpRunner + its mapping in resolve().
 * It does NOT need a vault, a throwaway item, or even a real `op` on PATH (the
 * whole point is that the named binary is absent), so it runs whenever the
 * opt-in switch is set — the cheapest way to actually execute the real
 * (rejecting) subprocess path rather than an injected fake.
 */
describe.skipIf(!OPT_IN)(
  "OnePasswordProvider — bogus cliPath ENOENT (gated on OP_INTEGRATION only)",
  () => {
    it("maps a missing op binary (ENOENT) to secret_backend_unavailable", async () => {
      const provider = new OnePasswordProvider({
        vault: "AnyVault",
        refTemplate: REF_TEMPLATE,
        cliPath: "op-does-not-exist-xyz",
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
