/**
 * Turn a service's `wrapper.ts` (Zod {@link ToolDescriptor}s) into a static
 * `manifest.json` the gateway consumes.
 *
 * Usage:
 *   tsx scripts/generate-manifest.ts <service-dir>
 *
 * For each exported `ToolDescriptor` it emits `{ id, name, description,
 * inputSchema, outputSchema, auth, wraps, entry, schemaHash }`. Zod stays the
 * single source of truth; `schemaHash` is the B2 drift-guard value — a stable
 * hash of the canonicalized input/output JSON Schema that Group C's startup
 * assertion and a CI check recompute the same way ({@link schemaHash}).
 *
 * Logging goes to stderr only; stdout is reserved for MCP framing elsewhere.
 */
import { writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDescriptor } from "../src/execute/descriptor.js";
import type { Manifest, ManifestTool } from "../src/catalog/types.js";

/** A manifest tool augmented with the B2 drift-guard `schemaHash`. */
export interface ManifestToolWithHash extends ManifestTool {
  /** Stable hash of the canonicalized `{inputSchema, outputSchema}` JSON. */
  schemaHash: string;
}

/** A manifest whose tools carry their drift-guard hash. */
export interface ManifestWithHashes extends Manifest {
  tools: ManifestToolWithHash[];
}

/**
 * Compute the stable drift-guard hash for a tool's input/output Zod schemas.
 *
 * Converts each schema to JSON Schema, canonicalizes the combined object with
 * sorted keys, and returns its sha256 hex. Deterministic regardless of object
 * key insertion order, so Group C's startup assertion and CI recompute it
 * identically.
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

/** Type guard: is `v` a `ToolDescriptor` (has id/name + Zod input/output + handler)? */
function isToolDescriptor(v: unknown): v is ToolDescriptor {
  if (v === null || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    typeof d.description === "string" &&
    typeof d.handler === "function" &&
    d.input != null &&
    d.output != null
  );
}

/**
 * Build the {@link Manifest} for `<serviceDir>/wrapper.ts` and write it to
 * `<serviceDir>/manifest.json`.
 *
 * @param serviceDir - absolute or relative path to the service directory.
 * @returns the manifest object (also written to disk).
 */
export async function generateManifest(serviceDir: string): Promise<ManifestWithHashes> {
  const dir = resolve(serviceDir);
  const service = basename(dir);
  const wrapperPath = join(dir, "wrapper.ts");

  const mod: Record<string, unknown> = await import(pathToFileURL(wrapperPath).href);

  const tools: ManifestToolWithHash[] = [];
  for (const [exportName, value] of Object.entries(mod)) {
    if (!isToolDescriptor(value)) continue;
    const d = value;
    const input = d.input as unknown as ZodTypeAny;
    const output = d.output as unknown as ZodTypeAny;

    const tool: ManifestToolWithHash = {
      id: d.id,
      name: d.name,
      description: d.description,
      inputSchema: zodToJsonSchema(input) as object,
      outputSchema: zodToJsonSchema(output) as object,
      ...(d.auth ? { auth: d.auth } : {}),
      ...(d.wraps ? { wraps: d.wraps } : {}),
      entry: `wrapper.ts#${exportName}`,
      schemaHash: schemaHash(input, output),
    };
    tools.push(tool);
  }

  // Stable tool order so the emitted file is deterministic across runs.
  tools.sort((a, b) => a.id.localeCompare(b.id));

  const manifest: ManifestWithHashes = {
    manifestVersion: 1,
    service,
    tools,
  };

  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

/** CLI entry: `tsx scripts/generate-manifest.ts <service-dir>`. */
async function main(): Promise<void> {
  const serviceDir = process.argv[2];
  if (!serviceDir) {
    console.error("usage: tsx scripts/generate-manifest.ts <service-dir>");
    process.exit(1);
  }
  const manifest = await generateManifest(serviceDir);
  console.error(
    `wrote ${manifest.tools.length} tool(s) to ${join(resolve(serviceDir), "manifest.json")}`,
  );
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
