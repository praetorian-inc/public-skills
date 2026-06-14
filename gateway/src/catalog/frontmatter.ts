/**
 * Parse the YAML frontmatter block of a SKILL.md.
 *
 * A SKILL.md begins with a `---`-delimited YAML block, e.g.:
 *
 *   ---
 *   name: adhering-to-yagni
 *   description: Use when ...
 *   ---
 *   # body...
 *
 * Returns the required `name` and `description`. Tolerates a missing trailing
 * newline and a missing body; errors clearly if the block or a required key is
 * absent.
 */
import { parse as parseYaml } from "yaml";

export interface Frontmatter {
  name: string;
  description: string;
}

/** Matches a leading `---` block: opening fence, YAML body, closing fence. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n[\s\S]*)?$/;

/**
 * Extract `{ name, description }` from a SKILL.md's frontmatter.
 *
 * @throws if there is no frontmatter block, or if `name`/`description` is missing.
 */
export function parseFrontmatter(markdown: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) {
    throw new Error("SKILL.md has no frontmatter block (expected a leading '---' delimited section)");
  }

  const parsed: unknown = parseYaml(match[1]) ?? {};
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("SKILL.md frontmatter is not a YAML mapping");
  }

  const fm = parsed as Record<string, unknown>;
  if (typeof fm.name !== "string" || fm.name.length === 0) {
    throw new Error("SKILL.md frontmatter is missing required key: name");
  }
  if (typeof fm.description !== "string" || fm.description.length === 0) {
    throw new Error("SKILL.md frontmatter is missing required key: description");
  }

  return { name: fm.name, description: fm.description };
}
