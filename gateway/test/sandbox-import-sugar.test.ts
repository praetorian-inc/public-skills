/**
 * Group C2 (WS-C) — `run_code` import-sugar wired through the real Sandbox.
 *
 * Proves the C-2 source transform (`desugarCapsImports`, applied before #compile)
 * lets model code use `import { tool } from "caps/<svc>"` and have it behave as
 * the existing frozen-global `caps.<svc>.<tool>`. Critically, it re-proves the P1
 * security invariants THROUGH an import-sugar program (plan §8.3): the transform
 * must not weaken deny-by-default egress, secret isolation, the `__capCall`
 * deletion, or injection-free codegen.
 *
 * Uses the existing fixture catalog (services `echo` + `secretecho`) and injected
 * fakes — no real network.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { Sandbox } from "../src/sandbox/sandbox.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogRoot = join(here, "fixtures/.agentsmesh");

let index: ReturnType<typeof buildIndex>;
let sandbox: Sandbox;

beforeAll(() => {
  index = buildIndex(catalogRoot);
  sandbox = new Sandbox({ index, secrets: new EnvProvider() });
});

afterEach(() => {
  delete process.env.TEST_SECRET;
});

describe("run_code import-sugar — functional", () => {
  it("a desugared named-import program calls a capability and returns its value", async () => {
    const result = await sandbox.run(
      [
        `import { echo } from "caps/echo";`,
        `return echo({ text: "hi" });`,
      ].join("\n"),
    );
    expect(result).toEqual({ text: "hi" });
  });

  it("composes TWO capability calls via import-sugar across two services", async () => {
    process.env.TEST_SECRET = "super-secret-value";
    const result = await sandbox.run(
      [
        `import { echo } from "caps/echo";`,
        `import { secretecho } from "caps/secretecho";`,
        `const a = echo({ text: "a" });`,
        `const b = secretecho({ text: "b" });`,
        `return { combined: a.text + b.text, secretSeen: b.secretSeen };`,
      ].join("\n"),
    );
    expect(result).toEqual({ combined: "ab", secretSeen: true });
  });

  it("a namespace-import program (import * as svc) calls a capability and returns its value", async () => {
    const result = await sandbox.run(
      [
        `import * as e from "caps/echo";`,
        `return e.echo({ text: "ns" });`,
      ].join("\n"),
    );
    expect(result).toEqual({ text: "ns" });
  });

  it("an aliased named import (a as b) calls a capability and returns its value", async () => {
    const result = await sandbox.run(
      [
        `import { echo as doEcho } from "caps/echo";`,
        `return doEcho({ text: "alias" });`,
      ].join("\n"),
    );
    expect(result).toEqual({ text: "alias" });
  });
});

describe("run_code import-sugar — P1 security invariants (§8.3)", () => {
  it("deny-by-default: import from an undeclared caps service → sandbox_error", async () => {
    // `caps.nope` is undefined (not in the index) → `const { x } = caps.nope`
    // throws a TypeError in-isolate, surfaced as a coded sandbox_error. Same
    // posture as the existing `caps.nope.nope({})` deny test.
    const err = (await sandbox
      .run(
        [
          `import { x } from "caps/nope";`,
          `return x({});`,
        ].join("\n"),
      )
      .catch((e: unknown) => e)) as GatewayError;
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe("sandbox_error");
  });

  it("secrets never enter the isolate, even via an import-sugar program", async () => {
    process.env.TEST_SECRET = "super-secret-value";
    const result = (await sandbox.run(
      [
        `import { secretecho } from "caps/secretecho";`,
        `const out = secretecho({ text: "hi" });`,
        `const leak = { env: typeof process, viaGlobal: typeof globalThis.TEST_SECRET };`,
        `return { out, leak };`,
      ].join("\n"),
    )) as { out: { text: string; secretSeen: boolean }; leak: Record<string, string> };
    expect(result.out).toEqual({ text: "hi", secretSeen: true });
    expect(result.leak).toEqual({ env: "undefined", viaGlobal: "undefined" });
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });

  it("__capCall is still deleted from the global in an import-sugar program", async () => {
    const result = await sandbox.run(
      [
        `import { echo } from "caps/echo";`,
        `echo({ text: "warm" });`,
        `return typeof __capCall;`,
      ].join("\n"),
    );
    expect(result).toBe("undefined");
  });

  it("injection-free: a malicious non-identifier binding does NOT execute its side effect", async () => {
    // The transform rejects a binding that is not a clean identifier. The side
    // effect (`globalThis.__pwned = ...`) must NOT run; the program fails with a
    // coded sandbox_error instead of executing attacker code.
    const err = (await sandbox
      .run(
        [
          `import { x = (globalThis.__pwned = 1) } from "caps/echo";`,
          `return globalThis.__pwned;`,
        ].join("\n"),
      )
      .catch((e: unknown) => e)) as GatewayError;
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe("sandbox_error");

    // Prove the side effect did not run in a fresh isolate: a benign program now
    // sees no `__pwned` global (fresh-isolate-per-call also guarantees this).
    const clean = await sandbox.run(`typeof globalThis.__pwned`);
    expect(clean).toBe("undefined");
  });
});
