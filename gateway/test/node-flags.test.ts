/**
 * Group A0 — `--no-node-snapshot` guard. The check is a pure function over the
 * two observable vectors (process.execArgv when passed directly, NODE_OPTIONS
 * when set via env) so it is testable without re-launching node. Missing flag
 * must throw a coded `config_invalid` GatewayError with a remediation message —
 * fail loud, never a cryptic native crash.
 */
import { describe, it, expect } from "vitest";
import { assertNodeSnapshotDisabled } from "../src/sandbox/node-flags.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

describe("assertNodeSnapshotDisabled", () => {
  it("passes when the flag is in execArgv", () => {
    expect(() =>
      assertNodeSnapshotDisabled({ execArgv: ["--no-node-snapshot"], nodeOptions: undefined }),
    ).not.toThrow();
  });

  it("passes when the flag is in NODE_OPTIONS", () => {
    expect(() =>
      assertNodeSnapshotDisabled({ execArgv: [], nodeOptions: "--max-old-space-size=64 --no-node-snapshot" }),
    ).not.toThrow();
  });

  it("throws config_invalid with remediation when the flag is absent", () => {
    try {
      assertNodeSnapshotDisabled({ execArgv: [], nodeOptions: undefined });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("config_invalid");
      expect((e as GatewayError).message).toContain("--no-node-snapshot");
    }
  });
});
