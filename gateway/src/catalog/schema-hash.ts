/**
 * The B2 drift-guard hash — the SINGLE source of truth shared by the manifest
 * generator (`scripts/generate-manifest.ts`), the startup drift assertion
 * (`src/execute/drift.ts`), and any CI check.
 *
 * Lives under `src/` so it is part of the published, compiled artifact and is
 * importable from both the gateway runtime and the dev-only generator script
 * (the script re-exports it). Keeping one implementation guarantees dev, CI, and
 * boot can never compute the hash differently.
 */
import { createHash } from "node:crypto";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Compute the stable drift-guard hash for a tool's input/output Zod schemas.
 *
 * Converts each schema to JSON Schema, canonicalizes the combined object with
 * recursively sorted keys, and returns its sha256 hex — deterministic regardless
 * of object key insertion order.
 */
export function schemaHash(input: ZodTypeAny, output: ZodTypeAny): string {
  const payload = {
    inputSchema: zodToJsonSchema(input),
    outputSchema: zodToJsonSchema(output),
  };
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

/** JSON-stringify with recursively sorted object keys (stable across orderings). */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
