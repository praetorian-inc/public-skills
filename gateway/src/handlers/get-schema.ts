/**
 * `get_schema` handler: return the static schema/detail for an id.
 *
 * - skill → `{kind:"skill", description, references}` (description from the
 *   SKILL.md frontmatter; references from a recursive dir scan, excluding
 *   SKILL.md itself).
 * - tool → `{kind:"tool", description, inputSchema, outputSchema, auth}` read
 *   straight from the manifest — **no wrapper module is loaded** (keeps startup
 *   and discovery fast).
 *
 * Reads only static files (SKILL.md, manifest.json).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogEntry } from "../catalog/types.js";
import { parseFrontmatter } from "../catalog/frontmatter.js";
import { loadManifest } from "../catalog/manifest.js";
import { listReferences } from "./skill-references.js";
import { unknownId } from "../errors/to-tool-error.js";

export interface SchemaInput {
  id: string;
}

export interface SchemaDeps {
  index: CatalogEntry[];
}

export interface SkillSchema {
  kind: "skill";
  description: string;
  references: string[];
}

export interface ToolSchema {
  kind: "tool";
  description: string;
  inputSchema: object;
  outputSchema: object;
  auth: string[];
}

export type SchemaDetail = SkillSchema | ToolSchema;

export async function getSchema(input: SchemaInput, deps: SchemaDeps): Promise<SchemaDetail> {
  const entry = deps.index.find((e) => e.id === input.id);
  if (!entry) throw unknownId(input.id);

  if (entry.kind === "skill") {
    const fm = parseFrontmatter(readFileSync(join(entry.path, "SKILL.md"), "utf8"));
    return {
      kind: "skill",
      description: fm.description,
      references: listReferences(entry.path),
    };
  }

  // tool: read the manifest (already validated by loadManifest) — no module load.
  const manifest = loadManifest(entry.path);
  const tool = manifest.tools.find((t) => t.id === entry.id);
  if (!tool) throw unknownId(input.id); // index/manifest disagree — treat as unknown
  return {
    kind: "tool",
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    auth: tool.auth ?? [],
  };
}
