import { describe, it, expect } from "vitest";
import {
  GatewayError,
  toToolError,
  unknownId,
  kindMismatch,
  invalidArgs,
  invalidOutput,
  missingSecret,
  secretBackendUnavailable,
  wrapperLoadFailed,
  manifestInvalid,
  manifestDrift,
  type GatewayErrorCode,
} from "../src/errors/to-tool-error.js";

describe("GatewayError", () => {
  it("carries a stable code and message", () => {
    const e = new GatewayError("unknown_id", "no such id: foo");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("unknown_id");
    expect(e.message).toBe("no such id: foo");
    expect(e.name).toBe("GatewayError");
  });
});

describe("coded error constructors", () => {
  const cases: Array<[() => GatewayError, GatewayErrorCode]> = [
    [() => unknownId("x"), "unknown_id"],
    [() => kindMismatch("x", "skill", "tool"), "kind_mismatch"],
    [() => invalidArgs("bad"), "invalid_args"],
    [() => invalidOutput("bad"), "invalid_output"],
    [() => missingSecret("API_KEY"), "missing_secret"],
    [() => secretBackendUnavailable("op not found"), "secret_backend_unavailable"],
    [() => wrapperLoadFailed("x", "boom"), "wrapper_load_failed"],
    [() => manifestInvalid("svc", "bad"), "manifest_invalid"],
    [() => manifestDrift("svc.tool"), "manifest_drift"],
  ];

  it.each(cases)("produces a GatewayError with the right code", (make, code) => {
    const e = make();
    expect(e).toBeInstanceOf(GatewayError);
    expect(e.code).toBe(code);
    expect(e.message.length).toBeGreaterThan(0);
  });

  it("names the offending id/key in the message", () => {
    expect(unknownId("foo").message).toContain("foo");
    expect(missingSecret("API_KEY").message).toContain("API_KEY");
  });
});

describe("toToolError", () => {
  it("maps a GatewayError to a structured MCP tool error", () => {
    const result = toToolError(unknownId("foo"));
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ code: "unknown_id", message: expect.stringContaining("foo") });
  });

  it("maps a Zod-style validation throw to invalid_args by default? No — non-GatewayError maps to a generic internal code", () => {
    const result = toToolError(new Error("totally unexpected"));
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
    expect(parsed.code).toBe("internal_error");
    expect(parsed.message).toContain("totally unexpected");
  });

  it("handles non-Error throws (strings, etc.)", () => {
    const result = toToolError("just a string");
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
    expect(parsed.code).toBe("internal_error");
    expect(parsed.message).toContain("just a string");
  });
});
