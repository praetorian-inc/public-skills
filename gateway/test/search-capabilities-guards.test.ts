/**
 * HIGH-1 — searchCapabilities k-cap (MAX_K=25) + description truncation (200).
 *
 * The existing fixture catalog has only 3 entries and short descriptions, so the
 * guards are vacuously tested. This file builds a LARGE isolated catalog in a
 * temp dir to PROVE the guards are real:
 *
 *   - k-cap: 30+ entries matching the query, k=1000 → EXACTLY 25 returned
 *   - truncate: an entry with a ≥500-char description → returned slice is
 *     EXACTLY 200 chars and equals description.slice(0,200)
 *
 * Uses only the shared fixture root for baseline; all large-catalog I/O goes
 * to mkdtempSync directories that are cleaned up in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { rankerFromConfig } from "../src/ranker/factory.js";
import { searchCapabilities, MAX_K, DESCRIPTION_BUDGET } from "../src/handlers/search-capabilities.js";

// ---- helpers ----------------------------------------------------------------

const LONG_DESC = "a".repeat(500); // 500 chars, well over the 200-char budget
const COMMON_WORD = "syntheticquerytermxyz"; // unlikely to collide with real catalog

let tmpRoot: string;

function createSkillDir(root: string, id: string, description: string): void {
  const dir = join(root, "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n# ${id}\n`,
    "utf8",
  );
}

// ---- setup ------------------------------------------------------------------

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "gateway-large-catalog-"));
  const agentsmesh = join(tmpRoot, ".agentsmesh");

  // Create 30 skill entries — all descriptions contain COMMON_WORD so they all
  // match the search query.  Entry #0 gets the long description.
  for (let i = 0; i < 30; i++) {
    const desc =
      i === 0
        ? `${COMMON_WORD} ${LONG_DESC}` // 500+ chars (COMMON_WORD prefix + 500 'a's)
        : `${COMMON_WORD} skill number ${i}`;
    createSkillDir(agentsmesh, `synthetic-skill-${i}`, desc);
  }
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---- tests ------------------------------------------------------------------

describe("searchCapabilities k-cap guard (HIGH-1)", () => {
  it("returns EXACTLY MAX_K (25) hits when ≥30 entries match and k=1000", async () => {
    const index = buildIndex(join(tmpRoot, ".agentsmesh"));
    const ranker = rankerFromConfig({ ranker: "keyword" });
    await ranker.index(index);

    const hits = await searchCapabilities({ query: COMMON_WORD, k: 1000 }, { index, ranker });

    // Must be EXACTLY 25, not just ≤25 (the vacuous case already passes ≤25).
    expect(hits.length).toBe(MAX_K);
  });
});

describe("searchCapabilities description truncation guard (HIGH-1)", () => {
  it("truncates the long-description entry to EXACTLY 200 chars", async () => {
    const index = buildIndex(join(tmpRoot, ".agentsmesh"));
    const ranker = rankerFromConfig({ ranker: "keyword" });
    await ranker.index(index);

    const hits = await searchCapabilities({ query: COMMON_WORD, k: 1000 }, { index, ranker });

    // Find the hit that originated from synthetic-skill-0 (long description).
    const longHit = hits.find((h) => h.id === "synthetic-skill-0");
    expect(longHit).toBeDefined();

    // Guard 1: length is exactly the budget (not ≤ which a no-op passes)
    expect(longHit!.description.length).toBe(DESCRIPTION_BUDGET);

    // Guard 2: the returned slice EXACTLY matches the first 200 chars of the
    // full description stored in the index entry — not just any 200-char string.
    const fullEntry = index.find((e) => e.id === "synthetic-skill-0")!;
    expect(longHit!.description).toBe(fullEntry.description.slice(0, DESCRIPTION_BUDGET));
  });
});
