/**
 * Core catalog contracts shared across the gateway.
 *
 * These are the exact shapes from the P0 implementation plan's "Core contracts"
 * section. They are intentionally framework-agnostic: no MCP, no Zod imports here
 * (Zod schemas that validate these live in `manifest.ts`).
 */

/** Whether a catalog entry is a skill (prose guidance) or a tool (executable). */
export type Kind = "skill" | "tool";

/**
 * The tiny index entry — ALL that search ranks over and the index holds.
 *
 * `path` is the on-disk location (skill dir or manifest path). It is used
 * internally for resolution but is NOT returned by `search_capabilities`.
 */
export interface CatalogEntry {
  /** skill: dir name; tool: "service.tool". Unique across the whole namespace. */
  id: string;
  kind: Kind;
  name: string;
  description: string;
  /** skill dir | manifest path (NOT returned by search). */
  path: string;
}

/** Detail returned by `get_schema` / `resolve_skill` for a skill. */
export interface SkillDetail {
  description: string;
  /** Relative paths under the skill dir (e.g. "references/checklist.md"). */
  references: string[];
}

/** Detail returned by `get_schema` for a tool. */
export interface ToolDetail {
  description: string;
  /** JSON Schema (from manifest). */
  inputSchema: object;
  /** JSON Schema (from manifest). */
  outputSchema: object;
  auth: string[];
}

/** A single tool entry within a service manifest. */
export interface ManifestTool {
  id: string;
  name: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  auth?: string[];
  wraps?: { type: "mcp" | "rest"; server?: string; tool?: string };
  /** "wrapper.ts#exportName" — resolved by the runner. */
  entry: string;
  /**
   * Stable hash of the emitted input/output JSON Schema (B2 drift guard).
   * Written by `generate-manifest`; recomputed from the live wrapper at boot/CI
   * by `assertNoDrift`. A mismatch is `manifest_drift`; absence is
   * `manifest_invalid` (validated below), not silently treated as drift.
   */
  schemaHash: string;
}

/**
 * A service manifest (`tools/<service>/manifest.json`).
 *
 * `manifestVersion` is the format version; the gateway rejects unknown majors
 * (see B2 drift guard / manifest_invalid error).
 */
export interface Manifest {
  manifestVersion: 1;
  service: string;
  tools: ManifestTool[];
}
