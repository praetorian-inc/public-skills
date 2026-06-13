/**
 * LOW — get-schema.ts:61: index/manifest-disagreement branch → unknown_id.
 *
 * When the catalog index contains a tool entry but the manifest.json at that
 * path does not actually list a tool with that id (index and manifest disagree),
 * getSchema must throw unknown_id rather than returning garbage.
 *
 * Uses a minimal temp-dir catalog so it doesn't touch the shared fixture.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSchema } from "../src/handlers/get-schema.js";
import type { CatalogEntry } from "../src/catalog/types.js";

let tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("getSchema — index/manifest-disagreement", () => {
  it("throws unknown_id when the index entry id is absent from the manifest tools list", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gw-getschema-"));
    tmpDirs.push(tmp);
    const svcDir = join(tmp, "tools", "disagree-svc");
    mkdirSync(svcDir, { recursive: true });
    const manifestPath = join(svcDir, "manifest.json");

    // Manifest lists "disagree-svc.realTool" but index will claim "disagree-svc.fakeTool".
    writeFileSync(manifestPath, JSON.stringify({
      manifestVersion: 1,
      service: "disagree-svc",
      tools: [{
        id: "disagree-svc.realTool",
        name: "realTool",
        description: "real",
        inputSchema: { type: "object", properties: {}, additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" },
        outputSchema: { type: "object", properties: {}, additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" },
        entry: "wrapper.ts#realTool",
        schemaHash: "aabbcc",
      }],
    }), "utf8");

    // Index entry claims a DIFFERENT id than what the manifest lists.
    const index: CatalogEntry[] = [{
      id: "disagree-svc.fakeTool",
      kind: "tool",
      name: "fakeTool",
      description: "id not in manifest",
      path: manifestPath,
    }];

    await expect(
      getSchema({ id: "disagree-svc.fakeTool" }, { index }),
    ).rejects.toMatchObject({ code: "unknown_id" });
  });
});
