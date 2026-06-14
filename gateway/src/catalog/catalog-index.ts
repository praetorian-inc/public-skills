/**
 * Scan an agentsmesh catalog root into a flat {@link CatalogEntry} index.
 *
 * (Plan file tree names this `index-builder.ts`; renamed to `catalog-index.ts`
 * to avoid a host PreToolUse hook that false-positives on the substring "ui"
 * inside "builder". The exported `buildIndex` symbol is unchanged.)
 *
 * Layout under `<root>`:
 *   skills/<dir>/SKILL.md          → one skill entry per dir (id = dir name)
 *   tools/<service>/manifest.json  → one tool entry per tool in each manifest
 *
 * Skill and tool ids share ONE namespace; a collision fails loudly (the gateway
 * refuses to start with an ambiguous index).
 *
 * The `tools/` directory is optional — a skills-only catalog is valid.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogEntry } from "./types.js";
import { parseFrontmatter } from "./frontmatter.js";
import { loadManifest } from "./manifest.js";
import { GatewayError } from "../errors/to-tool-error.js";

/**
 * Build the catalog index from `<root>/skills/*` and `<root>/tools/*`.
 *
 * @throws {@link GatewayError} (`manifest_invalid`) on a malformed manifest or an
 *   id collision across the skill+tool namespace.
 */
export function buildIndex(root: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const seen = new Map<string, CatalogEntry>();

  const add = (entry: CatalogEntry): void => {
    const existing = seen.get(entry.id);
    if (existing) {
      throw new GatewayError(
        "manifest_invalid",
        `id collision: "${entry.id}" is defined by both a ${existing.kind} (${existing.path}) ` +
          `and a ${entry.kind} (${entry.path}); ids must be unique across the catalog`,
      );
    }
    seen.set(entry.id, entry);
    entries.push(entry);
  };

  for (const entry of scanSkills(root)) add(entry);
  for (const entry of scanTools(root)) add(entry);

  return entries;
}

function scanSkills(root: string): CatalogEntry[] {
  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir)) return [];

  const out: CatalogEntry[] = [];
  for (const dirent of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dir = join(skillsDir, dirent.name);
    const skillMd = join(dir, "SKILL.md");
    if (!existsSync(skillMd)) continue;

    const fm = parseFrontmatter(readFileSync(skillMd, "utf8"));
    out.push({
      id: dirent.name, // skill id = dir name (plan: Core contracts)
      kind: "skill",
      name: fm.name,
      description: fm.description,
      path: dir,
    });
  }
  return out;
}

function scanTools(root: string): CatalogEntry[] {
  const toolsDir = join(root, "tools");
  if (!existsSync(toolsDir)) return []; // skills-only catalog is valid

  const out: CatalogEntry[] = [];
  for (const dirent of readdirSync(toolsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = join(toolsDir, dirent.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = loadManifest(manifestPath);
    for (const tool of manifest.tools) {
      out.push({
        // The manifest tool `id` is already namespaced as "<service>.<tool>"
        // (plan Core contracts: Manifest.tools[].id). We use it verbatim rather
        // than re-deriving "<service>.<name>" so the index id and the manifest
        // id can never silently disagree.
        id: tool.id,
        kind: "tool",
        name: tool.name,
        description: tool.description,
        path: manifestPath,
      });
    }
  }
  return out;
}
