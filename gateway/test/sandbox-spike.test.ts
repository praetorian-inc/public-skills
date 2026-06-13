/**
 * Group A0 — bridge spike. Encodes the §11.5 spike ground truth as tests:
 * the isolate boots, runs trivial source and copies the value out; a host
 * Reference round-trips synchronously via applySyncPromise; and the fresh
 * context denies process/require/fetch by default (T1 baseline).
 *
 * These run only because vitest.config.ts launches forks with
 * `--no-node-snapshot` (isolated-vm requires it on Node >= 20).
 */
import { describe, it, expect } from "vitest";
import { Sandbox } from "../src/sandbox/sandbox.js";

const sandbox = new Sandbox({ index: [], secrets: { async resolve() { return {}; } } });

describe("Sandbox A0 spike", () => {
  it("compiles, runs, and copies out a trivial return value", async () => {
    const result = await sandbox.run("1 + 1");
    expect(result).toBe(2);
  });

  it("returns an object built inside the isolate", async () => {
    const result = await sandbox.run("({ ok: true, n: 41 + 1 })");
    expect(result).toEqual({ ok: true, n: 42 });
  });

  it("denies process / require / fetch by default inside the isolate", async () => {
    const result = await sandbox.run(
      `({
         process: typeof process,
         require: typeof require,
         fetch: typeof fetch,
         globalProcess: typeof globalThis.process,
       })`,
    );
    expect(result).toEqual({
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      globalProcess: "undefined",
    });
  });
});
