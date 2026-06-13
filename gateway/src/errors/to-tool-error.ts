/**
 * Single error choke point (B3).
 *
 * All handler logic funnels through {@link toToolError} so the MCP layer never
 * sees a raw throw. Each of the 8 plan-specified failure modes is a stable
 * `code` on a {@link GatewayError}; anything else maps to `internal_error`.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Kind } from "../catalog/types.js";

/**
 * The stable runtime error codes the gateway explicitly handles.
 *
 * The first 8 are the P0 set (plan: Error handling B3). WS-1 adds the three
 * `sandbox_*` codes for `run_code` isolate failures; they are distinct so a
 * model can react differently (shorten work on timeout, reduce in-isolate data
 * on memory) and so a genuine bug (`sandbox_error`) is not confused with a
 * resource cap.
 */
export type GatewayErrorCode =
  | "unknown_id"
  | "kind_mismatch"
  | "invalid_args"
  | "invalid_output"
  | "missing_secret"
  | "wrapper_load_failed"
  | "manifest_invalid"
  | "manifest_drift"
  | "sandbox_timeout"
  | "sandbox_memory"
  | "sandbox_error";

/**
 * Startup/config codes — distinct from the 8 runtime codes above.
 * `config_invalid` covers a bad/unsupported `gateway.config.yaml` selection
 * (e.g. a ranker or secrets provider that isn't implemented in this phase);
 * `internal_error` is the fallback for any throw that is NOT a recognized
 * {@link GatewayError}.
 */
export type StartupErrorCode = "config_invalid" | "internal_error";

/**
 * An error carrying a stable, machine-readable `code`.
 *
 * Construct via the coded helpers ({@link unknownId}, {@link kindMismatch}, …)
 * rather than `new GatewayError(...)` directly, so messages stay consistent.
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode | "config_invalid";

  constructor(code: GatewayErrorCode | "config_invalid", message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

/** `id` not present in the index. */
export function unknownId(id: string): GatewayError {
  return new GatewayError("unknown_id", `unknown id: ${id}`);
}

/**
 * Wrong operation for the entry's kind — e.g. `resolve_skill` on a tool, or
 * `execute`/`get_schema(tool-path)` on a skill.
 */
export function kindMismatch(id: string, actual: Kind, expected: Kind): GatewayError {
  return new GatewayError(
    "kind_mismatch",
    `id "${id}" is a ${actual}, but this operation requires a ${expected}`,
  );
}

/** `input.parse(args)` failed (incl. Zod refinements JSON Schema can't express). */
export function invalidArgs(detail: string): GatewayError {
  return new GatewayError("invalid_args", `invalid args: ${detail}`);
}

/** Wrapper result failed `output.parse`. */
export function invalidOutput(detail: string): GatewayError {
  return new GatewayError("invalid_output", `invalid output: ${detail}`);
}

/** `SecretProvider.resolve` could not find a declared `auth` key. */
export function missingSecret(key: string): GatewayError {
  return new GatewayError("missing_secret", `missing secret: ${key}`);
}

/** `await import(entry)` threw, or the named export was not found. */
export function wrapperLoadFailed(entry: string, detail: string): GatewayError {
  return new GatewayError("wrapper_load_failed", `failed to load wrapper "${entry}": ${detail}`);
}

/** Manifest failed zod validation or had an unknown `manifestVersion` major. */
export function manifestInvalid(service: string, detail: string): GatewayError {
  return new GatewayError("manifest_invalid", `invalid manifest for "${service}": ${detail}`);
}

/** Manifest schema hash ≠ wrapper-derived hash (B2 drift guard). */
export function manifestDrift(toolId: string): GatewayError {
  return new GatewayError(
    "manifest_drift",
    `manifest schema for "${toolId}" drifted from the wrapper's Zod schema`,
  );
}

/** A `gateway.config.yaml` selection that is invalid or unsupported in this phase. */
export function configInvalid(detail: string): GatewayError {
  return new GatewayError("config_invalid", `invalid config: ${detail}`);
}

/** `run_code` isolate exceeded its wall-clock timeout. */
export function sandboxTimeout(timeoutMs: number): GatewayError {
  return new GatewayError("sandbox_timeout", `sandbox timed out after ${timeoutMs}ms`);
}

/** `run_code` isolate hit its memory cap (V8 OOM inside the isolate). */
export function sandboxMemory(memoryLimitMb: number): GatewayError {
  return new GatewayError("sandbox_memory", `sandbox exceeded its ${memoryLimitMb}MB memory limit`);
}

/**
 * `run_code` source threw, failed to compile, or returned a non-marshalable
 * value. `detail` is the isolate-side error string — never a host stack.
 */
export function sandboxError(detail: string): GatewayError {
  return new GatewayError("sandbox_error", `sandbox error: ${detail}`);
}

/**
 * Map any thrown value to a structured MCP tool error.
 *
 * This is the single choke point: handlers/runner funnel every failure through
 * here so the MCP transport always receives a well-formed `{ isError, content }`
 * result instead of an exception.
 */
export function toToolError(e: unknown): CallToolResult {
  const { code, message } = describe(e);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ code, message }) }],
  };
}

function describe(e: unknown): { code: GatewayErrorCode | StartupErrorCode; message: string } {
  if (e instanceof GatewayError) {
    return { code: e.code, message: e.message };
  }
  if (e instanceof Error) {
    return { code: "internal_error", message: e.message };
  }
  return { code: "internal_error", message: String(e) };
}
