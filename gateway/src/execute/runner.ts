/**
 * Execute a tool by id: load its wrapper module, validate args, inject secrets,
 * call the handler, validate the result.
 *
 * The runner is the only place that lazily imports a `wrapper.ts`/`.js` module —
 * index building and `get_schema` read only static files. Every failure mode is
 * a coded {@link GatewayError}; the handler layer funnels them through
 * `toToolError` so the MCP transport never sees a raw throw.
 */
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { CatalogEntry, Manifest } from "../catalog/types.js";
import { loadManifest } from "../catalog/manifest.js";
import type { ToolDescriptor } from "./descriptor.js";
import type { SecretProvider } from "../secrets/provider.js";
import { resolveWrapperPath, exportFromEntry } from "./wrapper-resolve.js";
import {
  GatewayError,
  invalidArgs,
  invalidOutput,
  kindMismatch,
  unknownId,
  wrapperLoadFailed,
} from "../errors/to-tool-error.js";

/** Dependencies the runner needs, injected for testability. */
export interface RunnerDeps {
  index: CatalogEntry[];
  secrets: SecretProvider;
}

/**
 * Look up `id`, load its wrapper descriptor, validate, resolve secrets, run, and
 * validate the output.
 *
 * @throws {@link GatewayError} with one of: `unknown_id`, `kind_mismatch`,
 *   `wrapper_load_failed`, `invalid_args`, `missing_secret`, `invalid_output`.
 */
export async function executeTool(
  id: string,
  args: unknown,
  deps: RunnerDeps,
): Promise<unknown> {
  const entry = deps.index.find((e) => e.id === id);
  if (!entry) throw unknownId(id);
  if (entry.kind !== "tool") throw kindMismatch(id, entry.kind, "tool");

  const descriptor = await loadDescriptor(entry);

  // input.parse → invalid_args (this is where Zod refinements JSON Schema can't
  // express are caught).
  let parsedArgs: unknown;
  try {
    parsedArgs = descriptor.input.parse(args);
  } catch (e) {
    throw invalidArgs(formatZod(e));
  }

  // resolve secrets (missing key → missing_secret, thrown by the provider).
  const secrets = await deps.secrets.resolve(descriptor.auth ?? []);

  const result = await descriptor.handler(parsedArgs, { secrets });

  // output.parse → invalid_output.
  try {
    return descriptor.output.parse(result);
  } catch (e) {
    throw invalidOutput(formatZod(e));
  }
}

/**
 * Resolve and import the wrapper module for `entry`, returning the
 * {@link ToolDescriptor} whose id matches.
 *
 * Entry resolution (B2): the manifest tool's `entry` is `wrapper.<ext>#<export>`.
 * We resolve the wrapper file next to the manifest via the shared
 * {@link resolveWrapperPath} (compiled `wrapper.js` preferred, `wrapper.ts`
 * fallback for dev/test). The export name comes from the entry string.
 */
async function loadDescriptor(entry: CatalogEntry): Promise<ToolDescriptor> {
  const serviceDir = dirname(entry.path);
  const manifest: Manifest = loadManifest(entry.path);
  const tool = manifest.tools.find((t) => t.id === entry.id);
  if (!tool) {
    throw wrapperLoadFailed(entry.path, `no tool "${entry.id}" in manifest`);
  }

  const exportName = exportFromEntry(tool.entry);
  const wrapperPath = resolveWrapperPath(serviceDir);
  if (!wrapperPath) {
    throw wrapperLoadFailed(tool.entry, `no wrapper.ts or wrapper.js in ${serviceDir}`);
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(wrapperPath).href)) as Record<string, unknown>;
  } catch (e) {
    throw wrapperLoadFailed(tool.entry, (e as Error).message);
  }

  const value = mod[exportName];
  if (!isToolDescriptor(value)) {
    throw wrapperLoadFailed(
      tool.entry,
      `export "${exportName}" is not a ToolDescriptor (or is missing)`,
    );
  }
  return value;
}

/** Structural check that a module export is a usable {@link ToolDescriptor}. */
function isToolDescriptor(v: unknown): v is ToolDescriptor {
  if (v === null || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.handler === "function" &&
    d.input instanceof z.ZodType &&
    d.output instanceof z.ZodType
  );
}

function formatZod(e: unknown): string {
  if (e instanceof z.ZodError) {
    return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  }
  if (e instanceof GatewayError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
