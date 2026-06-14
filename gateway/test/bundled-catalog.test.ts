/**
 * WS-B — bundled-catalog default boot + exports resolution (O5 + §7.1/§7.5).
 *
 * Two concerns:
 *  1. The bundled catalog the package ships (the output of `bundle-catalog`) is a
 *     valid catalog: `buildIndex` finds the full 5 tools + 7 skills and
 *     `assertNoDrift` passes — i.e. a no-config `npx` boot serves a real catalog.
 *  2. The `package.json` `exports`/`bin` map points the published "." entry at a
 *     real built file (`dist/index.js`), and exposes no internals (no barrel).
 *
 * The catalog assertions drive the SAME `bundleCatalog()` the build runs, so the
 * test is self-contained (no reliance on a prior `npm run build`).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { assertNoDrift } from "../src/execute/drift.js";
import { bundleCatalog, BUNDLE_DIR } from "../scripts/bundle-catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

describe("bundled catalog default boot (WS-B / O5)", () => {
  beforeAll(() => {
    // Populate dist/bundled-catalog from the source catalog (what the package
    // ships and what a no-config boot resolves to).
    bundleCatalog();
  });

  it("buildIndex finds exactly the 99 tools and 7 skills", () => {
    const index = buildIndex(BUNDLE_DIR);
    const skills = index.filter((e) => e.kind === "skill");
    const tools = index.filter((e) => e.kind === "tool");
    expect(skills.length).toBe(7);
    expect(tools.length).toBe(99);
    expect(tools.map((t) => t.id).sort()).toEqual(
      [
        "context7.get-library-docs",
        "context7.resolve-library-id",
        "linear.list_issues",
        "perplexity.ask",
        "perplexity.reason",
        "perplexity.research",
        "perplexity.search",
        "featurebase.list_posts",
        "featurebase.get_post",
        "featurebase.create_post",
        "featurebase.update_post",
        "featurebase.delete_post",
        "featurebase.list_changelog",
        "featurebase.get_changelog",
        "featurebase.create_changelog",
        "featurebase.update_changelog",
        "featurebase.delete_changelog",
        "featurebase.list_collections",
        "featurebase.create_collection",
        "featurebase.update_collection",
        "featurebase.delete_collection",
        "featurebase.list_articles",
        "featurebase.get_article",
        "featurebase.create_article",
        "featurebase.update_article",
        "featurebase.delete_article",
        "featurebase.list_comments",
        "featurebase.create_comment",
        "featurebase.update_comment",
        "featurebase.delete_comment",
        "featurebase.identify_user",
        "featurebase.get_user",
        "featurebase.list_users",
        "featurebase.delete_user",
        "featurebase.list_companies",
        "featurebase.create_company",
        "featurebase.list_webhooks",
        "featurebase.create_webhook",
        "featurebase.delete_webhook",
        "featurebase.list_custom_fields",
        "featurebase.create_custom_field",
        "featurebase.list_boards",
        // 57 new linear.* tools (ported from marketplace)
        "linear.archive_issue",
        "linear.archive_project",
        "linear.createDocument",
        "linear.create_attachment",
        "linear.create_comment",
        "linear.create_cycle",
        "linear.create_favorite",
        "linear.create_initiative",
        "linear.create_issue",
        "linear.create_issue_relation",
        "linear.create_label",
        "linear.create_project",
        "linear.create_project_from_template",
        "linear.create_reaction",
        "linear.create_workflow_state",
        "linear.delete_attachment",
        "linear.delete_favorite",
        "linear.delete_initiative",
        "linear.delete_issue_relation",
        "linear.delete_label",
        "linear.delete_project",
        "linear.delete_reaction",
        "linear.documents",
        "linear.find_issue",
        "linear.find_user",
        "linear.get_cycle",
        "linear.get_document",
        "linear.get_initiative",
        "linear.get_issue",
        "linear.get_label",
        "linear.get_project",
        "linear.get_team",
        "linear.get_template",
        "linear.get_workflow_state",
        "linear.link_project_to_initiative",
        "linear.list_attachments",
        "linear.list_comments",
        "linear.list_cycles",
        "linear.list_initiatives",
        "linear.list_issue_relations",
        "linear.list_labels",
        "linear.list_project_templates",
        "linear.list_projects",
        "linear.list_teams",
        "linear.list_users",
        "linear.list_workflow_states",
        "linear.subscribe_to_issue",
        "linear.unarchive_issue",
        "linear.unsubscribe_from_issue",
        "linear.updateDocument",
        "linear.update_attachment",
        "linear.update_cycle",
        "linear.update_initiative",
        "linear.update_issue",
        "linear.update_label",
        "linear.update_project",
        "linear.update_workflow_state",
      ].sort(),
    );
  });

  it("passes the drift guard against the bundled (compiled .js) wrappers", async () => {
    const index = buildIndex(BUNDLE_DIR);
    // No throw === no drift. assertNoDrift imports each bundled wrapper.js and
    // recomputes the schemaHash, proving SF-1 (bare-Node-loadable .js + zod).
    await expect(assertNoDrift(index)).resolves.toBeUndefined();
  });

  it("ships compiled .js wrappers, never .ts, in the bundle", () => {
    const index = buildIndex(BUNDLE_DIR);
    for (const tool of index.filter((e) => e.kind === "tool")) {
      const svcDir = dirname(tool.path); // tool.path === <svc>/manifest.json
      expect(existsSync(join(svcDir, "wrapper.js"))).toBe(true);
      expect(existsSync(join(svcDir, "wrapper.ts"))).toBe(false);
    }
  });
});

describe("package exports map (WS-B B2)", () => {
  const pkg = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8"),
  ) as {
    exports?: Record<string, string>;
    bin?: Record<string, string>;
    files?: string[];
    optionalDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  it('exports "." → ./dist/index.js (single public entry, no barrel internals)', () => {
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports!["."]).toBe("./dist/index.js");
    // No internal subpath exports (avoiding-barrel-files): only "." is public.
    expect(Object.keys(pkg.exports!)).toEqual(["."]);
  });

  it("the entry the exports map points at is a real built file", () => {
    // Resolve "." against the package root the way a consumer's loader would.
    const entry = join(projectRoot, pkg.exports!["."]);
    expect(existsSync(entry)).toBe(true);
  });

  it("bin points at the same compiled entry", () => {
    expect(pkg.bin?.["capability-gateway"]).toBe("./dist/index.js");
  });

  it("files includes dist, README, LICENSE (and excludes src/test by omission)", () => {
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
    expect(pkg.files).not.toContain("src");
    expect(pkg.files).not.toContain("test");
  });

  it("isolated-vm is an optionalDependency (O9), not a hard dependency", () => {
    expect(pkg.optionalDependencies?.["isolated-vm"]).toBeDefined();
    expect(pkg.dependencies?.["isolated-vm"]).toBeUndefined();
  });
});
