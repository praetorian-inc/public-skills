/**
 * Group C — limits + error taxonomy (§6.2 d/e, §11 T2).
 *
 * A wall-clock timeout and a memory cap bound a hostile program; every isolate
 * failure funnels to a coded GatewayError. A capability call with bad args
 * inside run_code surfaces the P0 `invalid_args` code (proving the reused
 * executeTool path, not a new one).
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

beforeAll(() => {
  index = buildIndex(catalogRoot);
});

describe("Sandbox limits + error taxonomy", () => {
  it("maps an infinite loop to sandbox_timeout within the configured timeout", async () => {
    const sandbox = new Sandbox({
      index,
      secrets: new EnvProvider(),
      limits: { timeoutMs: 200 },
    });
    const start = Date.now();
    await expect(sandbox.run(`while (true) {}`)).rejects.toMatchObject({
      code: "sandbox_timeout",
    });
    // Terminated near the timeout, not hung indefinitely.
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("maps a runaway allocation to sandbox_memory", async () => {
    const sandbox = new Sandbox({
      index,
      secrets: new EnvProvider(),
      limits: { memoryLimitMb: 8, timeoutMs: 5000 },
    });
    // Grow an array until the 8MB isolate heap is exhausted.
    await expect(
      sandbox.run(`(() => { const a = []; while (true) { a.push(new Array(100000).fill(7)); } })()`),
    ).rejects.toMatchObject({ code: "sandbox_memory" });
  });

  it("maps a model throw to sandbox_error with a sanitized message (no host stack)", async () => {
    const sandbox = new Sandbox({ index, secrets: new EnvProvider() });
    try {
      await sandbox.run(`(() => { throw new Error("boom from model"); })()`);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as { code: string }).code).toBe("sandbox_error");
      const msg = (e as Error).message;
      expect(msg).toContain("boom from model");
      // No host file paths / stack frames leaked into the coded error message.
      expect(msg).not.toContain("sandbox.ts");
      expect(msg).not.toContain("/src/");
    }
  });

  it("surfaces the P0 invalid_args code for a bad-args capability call inside run_code", async () => {
    const sandbox = new Sandbox({ index, secrets: new EnvProvider() });
    // echo requires { text: string }; pass a number → invalid_args from executeTool.
    await expect(sandbox.run(`caps.echo.echo({ text: 123 })`)).rejects.toMatchObject({
      code: "invalid_args",
    });
  });
});
