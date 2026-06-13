/**
 * Load and zod-validate a service `manifest.json` against the {@link Manifest} shape.
 *
 * Rejects malformed manifests and unknown `manifestVersion` majors with a
 * `manifest_invalid` {@link GatewayError} (the single coded error for this case).
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Manifest } from "./types.js";
import { manifestInvalid } from "../errors/to-tool-error.js";

/** JSON Schema objects are opaque to the gateway; we only require them to be objects. */
const jsonSchema = z.object({}).passthrough();

const manifestToolSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  inputSchema: jsonSchema,
  outputSchema: jsonSchema,
  auth: z.array(z.string()).optional(),
  wraps: z
    .object({
      type: z.enum(["mcp", "rest"]),
      server: z.string().optional(),
      tool: z.string().optional(),
    })
    .optional(),
  entry: z.string().min(1),
  // B2 drift guard: a manifest missing its schemaHash is manifest_invalid here,
  // rather than slipping through to a (wrong-code) manifest_drift later.
  schemaHash: z.string().min(1),
});

const manifestSchema = z.object({
  // Only major version 1 is supported in P0; any other value is rejected.
  manifestVersion: z.literal(1),
  service: z.string().min(1),
  tools: z.array(manifestToolSchema),
});

/**
 * Read, JSON-parse, and validate the manifest at `path`.
 *
 * @throws {@link GatewayError} with code `manifest_invalid` on unreadable/invalid
 *   JSON, schema-validation failure, or an unknown `manifestVersion` major.
 */
export function loadManifest(path: string): Manifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw manifestInvalid(path, `unreadable: ${(e as Error).message}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw manifestInvalid(path, `not valid JSON: ${(e as Error).message}`);
  }

  const result = manifestSchema.safeParse(data);
  if (!result.success) {
    const service = serviceName(data) ?? path;
    throw manifestInvalid(service, summarize(result.error));
  }

  return result.data as Manifest;
}

/** Best-effort service name for error messages, before validation succeeds. */
function serviceName(data: unknown): string | undefined {
  if (typeof data === "object" && data !== null) {
    const svc = (data as Record<string, unknown>).service;
    if (typeof svc === "string") return svc;
  }
  return undefined;
}

function summarize(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
