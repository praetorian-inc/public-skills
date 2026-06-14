/**
 * WS-B Group B1 — packaging contents (O5 + §7.5).
 *
 * Drives `npm pack --dry-run --json` (the real npm pack file resolver) and
 * asserts the published tarball INCLUDES the compiled entry, the bundled
 * catalog (≥1 tool manifest.json + wrapper.js, ≥1 skill SKILL.md), README, and
 * LICENSE — and EXCLUDES `src/`, `test/`, any bundled `wrapper.ts`, and the
 * dev-only zod symlink.
 *
 * Slow/gated: it shells out to `npm pack` and depends on a built `dist/` (incl.
 * the bundled catalog), which it ensures in `beforeAll` by running the build's
 * `bundleCatalog()` step. The `dist/index.js` precondition mirrors the SF-1
 * integration test — run `npm run build` first.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleCatalog, BUNDLE_DIR } from "../scripts/bundle-catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const distIndex = join(projectRoot, "dist", "index.js");

interface PackEntry {
  path: string;
}
interface PackResult {
  files: PackEntry[];
}

let files: string[];

beforeAll(() => {
  if (!existsSync(distIndex)) {
    throw new Error(
      `dist/index.js not found — run 'npm run build' before the pack test`,
    );
  }
  // Ensure the bundled catalog is present + fresh (the build does this; we
  // re-run the same step so the test is robust to a partial build).
  bundleCatalog();

  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    // npm prints the human summary to stderr; the JSON goes to stdout.
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(out) as PackResult[];
  // `npm pack --json` returns an array (one per packed package).
  files = parsed[0].files.map((f) => f.path.replace(/\\/g, "/"));
}, 120_000);

describe("npm pack contents (WS-B B1)", () => {
  it("includes the compiled entry point", () => {
    expect(files).toContain("dist/index.js");
  });

  it("includes README and LICENSE", () => {
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
  });

  it("includes the bundled catalog ESM marker", () => {
    expect(files).toContain("dist/bundled-catalog/package.json");
  });

  it("includes at least one bundled tool (manifest.json + compiled wrapper.js)", () => {
    const manifests = files.filter(
      (f) => f.startsWith("dist/bundled-catalog/tools/") && f.endsWith("/manifest.json"),
    );
    const wrappers = files.filter(
      (f) => f.startsWith("dist/bundled-catalog/tools/") && f.endsWith("/wrapper.js"),
    );
    expect(manifests.length).toBeGreaterThan(0);
    expect(wrappers.length).toBeGreaterThan(0);
  });

  it("includes at least one bundled skill SKILL.md", () => {
    const skills = files.filter(
      (f) => f.startsWith("dist/bundled-catalog/skills/") && f.endsWith("/SKILL.md"),
    );
    expect(skills.length).toBeGreaterThan(0);
  });

  it("EXCLUDES TypeScript sources and tests", () => {
    expect(files.some((f) => f.startsWith("src/"))).toBe(false);
    expect(files.some((f) => f.startsWith("test/"))).toBe(false);
    expect(files.some((f) => f.startsWith("scripts/"))).toBe(false);
  });

  it("EXCLUDES any bundled wrapper.ts (only compiled .js ships — SF-1)", () => {
    const tsWrappers = files.filter(
      (f) => f.startsWith("dist/bundled-catalog/") && f.endsWith(".ts"),
    );
    expect(tsWrappers).toEqual([]);
  });

  it("EXCLUDES node_modules and the dev-only zod symlink", () => {
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("does not double-pack the served catalog at dist/catalog (compiled module only)", () => {
    // dist/catalog/ is the compiled src/catalog module; the served catalog data
    // (skills/, tools/) lives ONLY under dist/bundled-catalog/, never dist/catalog/.
    const strayCatalogData = files.filter(
      (f) =>
        f.startsWith("dist/catalog/") &&
        (f.endsWith("SKILL.md") || f.endsWith("manifest.json") || f.endsWith("wrapper.js")),
    );
    expect(strayCatalogData).toEqual([]);
  });

  it("verifies the bundle dir constant resolves under dist/", () => {
    expect(BUNDLE_DIR.replace(/\\/g, "/")).toContain("/dist/bundled-catalog");
  });
});
