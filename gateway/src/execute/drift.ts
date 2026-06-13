/**
 * Startup drift guard (B2).
 *
 * For each tool in each service manifest, recompute the input/output schema hash
 * from the LIVE wrapper's Zod descriptors and compare it to the hash stored in
 * `manifest.json`. A mismatch means `get_schema` (which reads the static
 * manifest) would silently disagree with `execute` (which runs the live Zod) —
 * so we refuse to start with a `manifest_drift` {@link GatewayError}.
 *
 * The hash is recomputed with the SAME `schemaHash(...)` the manifest generator
 * uses — both import it from `../catalog/schema-hash.js` (the single source of
 * truth), so dev, CI, and this boot assertion can never compute it differently.
 *
 * A CI check can call {@link assertNoDrift} directly with a freshly built index.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ZodTypeAny } from "zod";
import type { CatalogEntry } from "../catalog/types.js";
import type { ToolDescriptor } from "./descriptor.js";
// Reuse the EXACT hash function the manifest generator wrote with.
import { schemaHash } from "../catalog/schema-hash.js";
// Resolve wrapper file + export the SAME way the runner does (single source of truth).
import { resolveWrapperPath, exportFromEntry } from "./wrapper-resolve.js";
import { manifestDrift, wrapperLoadFailed } from "../errors/to-tool-error.js";

/**
 * Assert that no tool's stored manifest hash has drifted from its live wrapper.
 *
 * @param index - the built catalog index.
 * @throws {@link GatewayError} (`manifest_drift`) on any mismatch, or
 *   (`wrapper_load_failed`) if a wrapper/export referenced by the manifest is
 *   missing.
 */
export async function assertNoDrift(index: CatalogEntry[]): Promise<void> {
  // Unique manifest paths among tool entries.
  const manifestPaths = new Set<string>();
  for (const entry of index) {
    if (entry.kind === "tool") manifestPaths.add(entry.path);
  }

  for (const manifestPath of manifestPaths) {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as RawManifest;
    const serviceDir = dirname(manifestPath);
    const wrapperPath = resolveWrapperPath(serviceDir);
    if (!wrapperPath) {
      throw wrapperLoadFailed(manifestPath, `no wrapper.ts or wrapper.js in ${serviceDir}`);
    }

    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(wrapperPath).href)) as Record<string, unknown>;
    } catch (e) {
      throw wrapperLoadFailed(manifestPath, (e as Error).message);
    }

    for (const tool of raw.tools ?? []) {
      const exportName = exportFromEntry(tool.entry);
      const descriptor = mod[exportName];
      if (!isToolDescriptor(descriptor)) {
        throw wrapperLoadFailed(tool.entry, `export "${exportName}" is not a ToolDescriptor`);
      }
      const live = schemaHash(
        descriptor.input as unknown as ZodTypeAny,
        descriptor.output as unknown as ZodTypeAny,
      );
      if (live !== tool.schemaHash) {
        throw manifestDrift(tool.id);
      }
    }
  }
}

interface RawManifestTool {
  id: string;
  entry: string;
  schemaHash: string;
}
interface RawManifest {
  tools?: RawManifestTool[];
}

function isToolDescriptor(v: unknown): v is ToolDescriptor {
  if (v === null || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return d.input instanceof z.ZodType && d.output instanceof z.ZodType;
}
