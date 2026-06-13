/**
 * Group T1 — isolate escape (§11 threat model T1).
 *
 * Asserts that model code CANNOT reach the Node host through any escape
 * vector the preamble is designed to close. The implementation is known-green
 * (probed during the A0 spike); these tests LOCK the behavior so a future
 * regression in bridge.ts causes immediate test failure.
 *
 * Assertions:
 *   1. Function-constructor escape: `(function(){}).constructor("return typeof process")()`
 *      yields "undefined" — the V8 isolate's global has no host `process`.
 *   2. Raw host Reference deleted: `typeof __capCall` is "undefined" because
 *      the preamble does `delete globalThis.__capCall` after building `caps`.
 *   3. `caps` is frozen: assigning/adding a property on `caps.echo` is a no-op
 *      (or throws in strict mode) and does NOT corrupt later capability calls.
 *   4. Undeclared globals (fetch / require / globalThis.process) are undefined
 *      (cross-check with the spike baseline; intentionally not duplicating the
 *      full spike test — one focused assertion is non-vacuous).
 *
 * Mutation evidence (required by the task brief):
 *   The comment block below records the RED experiment that proves non-vacuity
 *   for assertion 2. The experiment was run against a scratch copy where the
 *   `delete globalThis.__capCall` line was commented out, and the assertion
 *   failed ("function" instead of "undefined"). The src/ tree was immediately
 *   restored to the pristine git state.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { Sandbox } from "../src/sandbox/sandbox.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogRoot = join(here, "fixtures/.agentsmesh");

let index: ReturnType<typeof buildIndex>;
let sandbox: Sandbox;

beforeAll(() => {
  index = buildIndex(catalogRoot);
  sandbox = new Sandbox({ index, secrets: new EnvProvider() });
});

describe("Sandbox isolate escape (T1)", () => {
  /**
   * Assertion 1 — Function-constructor escape.
   *
   * The classic "constructor chain" escape tries to reach the outer execution
   * context through `(function(){}).constructor` (which is the Function
   * constructor) and then `("return <global>")()`). Inside a fresh V8 isolate
   * that has no host bindings, `process` is undefined — the constructor chain
   * can't springboard into Node.
   */
  it("Function-constructor escape yields undefined for host process", async () => {
    const result = await sandbox.run(
      `(function(){}).constructor("return typeof process")()`,
    );
    expect(result).toBe("undefined");
  });

  /**
   * Assertion 2 — Raw host Reference deleted from global.
   *
   * The preamble captures the `__capCall` Reference into a closure-local `__ref`
   * and then does `delete globalThis.__capCall`. Model code therefore sees
   * `typeof __capCall === "undefined"`.
   *
   * MUTATION EVIDENCE (non-vacuity proof):
   *   In a scratch copy of src/sandbox/bridge.ts the line
   *       `delete globalThis.__capCall;`
   *   was commented out. Running ONLY this test file produced:
   *       Expected "undefined", received "function"
   *   Confirming the test goes RED when the defense is absent.
   *   The scratch copy was discarded; `git status src/` shows no changes.
   */
  it("raw host __capCall Reference is deleted from the isolate global after preamble", async () => {
    const result = await sandbox.run(`typeof __capCall`);
    expect(result).toBe("undefined");
  });

  /**
   * Assertion 3 — `caps` object and service sub-objects are frozen.
   *
   * Model code that attempts to reassign or add a property on `caps.echo`
   * either silently fails (non-strict) or throws (strict). After the attempt,
   * `caps.echo.echo` is still the original frozen function and a capability
   * call through it still works correctly.
   */
  it("caps is frozen: reassigning caps.echo.echo is a no-op and the tool still works", async () => {
    const result = await sandbox.run(`
      (() => {
        // Attempt silent mutation (the preamble runs "use strict" but model source
        // may not — test the non-throwing path; strict-mode branches produce the
        // same observable outcome: the assignment doesn't take).
        try { caps.echo.echo = "HACKED"; } catch (_) { /* strict-mode TypeError; expected */ }
        try { caps.echo.INJECTED = 1; } catch (_) { /* strict-mode TypeError; expected */ }
        // The original tool must still be callable after the attempted mutation.
        const out = caps.echo.echo({ text: "after-freeze-attempt" });
        return {
          toolStillCallable: out.text === "after-freeze-attempt",
          echoIsNotString: typeof caps.echo.echo !== "string",
          injectedAbsent: caps.echo.INJECTED === undefined,
        };
      })()
    `);
    expect(result).toEqual({
      toolStillCallable: true,
      echoIsNotString: true,
      injectedAbsent: true,
    });
  });

  /**
   * Assertion 4 — Undeclared globals are undefined.
   *
   * Cross-check the spike baseline (T1 deny-by-default confirmed). This is a
   * focused subset — the full baseline lives in sandbox-spike.test.ts; we keep
   * one assertion here to anchor the escape test file to the T1 narrative.
   */
  it("undeclared host globals (fetch, require) are undefined inside the isolate", async () => {
    const result = await sandbox.run(
      `({ fetch: typeof fetch, require: typeof require })`,
    );
    expect(result).toEqual({ fetch: "undefined", require: "undefined" });
  });
});
