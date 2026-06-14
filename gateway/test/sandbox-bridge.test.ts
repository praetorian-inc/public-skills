/**
 * Group B — capability bridge + value marshaling.
 *
 * Proves the §6.4 bridge contract: model code reaches capabilities ONLY through
 * `caps.<service>.<tool>(args)`, each routed host-side through the real P0
 * `executeTool` path (validation + secret injection + output validation). Per
 * §11.5 the call returns SYNCHRONOUSLY inside the isolate — no `await` in model
 * source. Args/results marshal as JSON; non-clonable returns → `sandbox_error`,
 * never a host crash. Secret invariant (a): a tool with `auth` resolves its
 * secret host-side, and the value is unreadable inside the isolate.
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

describe("Sandbox capability bridge", () => {
  it("calls caps.echo.echo synchronously (no await) via the host executeTool path", async () => {
    const result = await sandbox.run(`caps.echo.echo({ text: "hello" })`);
    expect(result).toEqual({ text: "hello" });
  });

  it("marshals nested objects and arrays across the boundary", async () => {
    const result = await sandbox.run(
      `(() => {
         const r = caps.echo.echo({ text: "x" });
         return { wrapped: { r, list: [1, 2, 3], n: 7 } };
       })()`,
    );
    expect(result).toEqual({ wrapped: { r: { text: "x" }, list: [1, 2, 3], n: 7 } });
  });

  it("composes two capability calls and keeps intermediate data in-isolate", async () => {
    const result = await sandbox.run(
      `(() => {
         const a = caps.echo.echo({ text: "a" });
         const b = caps.echo.echo({ text: "b" });
         return a.text + b.text;
       })()`,
    );
    expect(result).toBe("ab");
  });

  it("returns sandbox_error (not a host crash) for a non-clonable return value", async () => {
    await expect(sandbox.run(`(() => () => 1)()`)).rejects.toMatchObject({
      code: "sandbox_error",
    });
  });

  it("denies an undeclared capability (deny-by-default): caps.nope.* is not reachable → sandbox_error", async () => {
    // The preamble builds `caps` accessors ONLY for tools in the index, so an
    // undeclared service/tool is simply absent from `caps`. Reaching it throws
    // in-isolate (TypeError on `undefined`), surfaced as a coded sandbox_error.
    // This is STRONGER than routing unknown_id out: the model cannot even name a
    // capability the gateway did not expose (plan §11 T6 reconciled to this).
    const err = (await sandbox.run(`caps.nope.nope({})`).catch((e: unknown) => e)) as GatewayError;
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe("sandbox_error");
  });

  it("resolves a tool's secret host-side; the secret is unreadable inside the isolate", async () => {
    process.env.TEST_SECRET = "super-secret-value";
    const result = (await sandbox.run(
      `(() => {
         const out = caps.secretecho.secretecho({ text: "hi" });
         // Attempts to read the secret from inside the isolate:
         const leak = {
           env: typeof process,
           viaGlobal: typeof globalThis.TEST_SECRET,
         };
         return { out, leak };
       })()`,
    )) as { out: { text: string; secretSeen: boolean }; leak: Record<string, string> };

    // Handler saw the secret host-side:
    expect(result.out).toEqual({ text: "hi", secretSeen: true });
    // The isolate could not reach the secret nor process.env:
    expect(result.leak).toEqual({ env: "undefined", viaGlobal: "undefined" });
  });

  it("never exposes the secret VALUE anywhere in the marshaled result", async () => {
    process.env.TEST_SECRET = "super-secret-value";
    const result = await sandbox.run(`caps.secretecho.secretecho({ text: "hi" })`);
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });
});
