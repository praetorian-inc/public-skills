/**
 * List a skill's reference files as paths relative to the skill directory.
 *
 * Recursively scans the skill dir, returning every file EXCEPT the top-level
 * `SKILL.md` (which is the body, not a reference). Shared by `get_schema` and
 * `resolve_skill` so both report the same reference set.
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Return relative reference paths (POSIX-style separators) under `skillDir`. */
export function listReferences(skillDir: string): string[] {
  const out: string[] = [];
  walk(skillDir, skillDir, out);
  return out.sort();
}

function walk(root: string, dir: string, out: string[]): void {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!dirent.isFile()) continue;
    const rel = relative(root, full);
    if (rel === "SKILL.md") continue; // the body, not a reference
    out.push(rel.split(sep).join("/"));
  }
}
