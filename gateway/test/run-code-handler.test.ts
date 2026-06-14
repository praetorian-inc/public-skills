/**
 * Group D — run_code handler.
 *
 * The handler validates `{ source }` (empty → invalid_args via the P0 code path)
 * and delegates to the sandbox. The "token win" (§6.2 b): a program that builds
 * large intermediate data in-isolate and returns a small value marshals out only
 * the small value — intermediate rows never cross the boundary.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { Sandbox } from "../src/sandbox/sandbox.js";
import { runCode } from "../src/handlers/run-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogRoot = join(here, "fixtures/.agentsmesh");

let sandbox: Sandbox;

beforeAll(() => {
  const index = buildIndex(catalogRoot);
  sandbox = new Sandbox({ index, secrets: new EnvProvider() });
});

describe("run_code handler", () => {
  it("rejects empty source with invalid_args", async () => {
    await expect(runCode({ source: "" }, { sandbox })).rejects.toMatchObject({
      code: "invalid_args",
    });
  });

  it("rejects whitespace-only source with invalid_args", async () => {
    await expect(runCode({ source: "   \n  " }, { sandbox })).rejects.toMatchObject({
      code: "invalid_args",
    });
  });

  it("runs a valid program and returns its value", async () => {
    const result = await runCode({ source: `40 + 2` }, { sandbox });
    expect(result).toBe(42);
  });

  it("token win: builds 10k rows in-isolate, returns only 1 row", async () => {
    const result = (await runCode(
      {
        source: `(() => {
          const rows = [];
          for (let i = 0; i < 10000; i++) rows.push({ i, payload: "x".repeat(20) });
          const one = rows.filter((r) => r.i === 4242)[0];
          return { one, rowCount: rows.length };
        })()`,
      },
      { sandbox },
    )) as { one: { i: number }; rowCount: number };

    expect(result.rowCount).toBe(10000);
    expect(result.one.i).toBe(4242);
    // Only the small return value crossed: serializing it is tiny, nowhere near
    // the 10k-row intermediate (which never left the isolate).
    expect(JSON.stringify(result).length).toBeLessThan(200);
  });
});
