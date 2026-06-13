/**
 * `resolve_skill` handler: return a skill's full `SKILL.md` body and its
 * reference list.
 *
 * `id` must be a skill; a tool id → `kind_mismatch`, an absent id → `unknown_id`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogEntry } from "../catalog/types.js";
import { listReferences } from "./skill-references.js";
import { kindMismatch, unknownId } from "../errors/to-tool-error.js";

export interface ResolveInput {
  id: string;
}

export interface ResolveDeps {
  index: CatalogEntry[];
}

export interface ResolvedSkill {
  markdown: string;
  references: string[];
}

export async function resolveSkill(
  input: ResolveInput,
  deps: ResolveDeps,
): Promise<ResolvedSkill> {
  const entry = deps.index.find((e) => e.id === input.id);
  if (!entry) throw unknownId(input.id);
  if (entry.kind !== "skill") throw kindMismatch(input.id, entry.kind, "skill");

  return {
    markdown: readFileSync(join(entry.path, "SKILL.md"), "utf8"),
    references: listReferences(entry.path),
  };
}
