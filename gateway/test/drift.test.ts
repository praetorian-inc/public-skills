import { describe, it, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { assertNoDrift } from "../src/execute/drift.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogRoot = join(here, "fixtures/.agentsmesh");
const echoDir = join(catalogRoot, "tools/echo");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Build a throwaway catalog root containing only the echo tool, returning root. */
function tmpEchoCatalog(mutateManifest?: (m: Record<string, unknown>) => void): string {
  const root = mkdtempSync(join(tmpdir(), "gw-drift-"));
  tmpDirs.push(root);
  const svc = join(root, "tools/echo");
  mkdirSync(svc, { recursive: true });
  copyFileSync(join(echoDir, "wrapper.ts"), join(svc, "wrapper.ts"));

  const manifest = JSON.parse(readFileSync(join(echoDir, "manifest.json"), "utf8"));
  if (mutateManifest) mutateManifest(manifest);
  writeFileSync(join(svc, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return root;
}

describe("assertNoDrift", () => {
  it("passes when every manifest hash matches the live wrapper zod", async () => {
    const index = buildIndex(catalogRoot);
    await expect(assertNoDrift(index)).resolves.toBeUndefined();
  });

  it("throws manifest_drift when a stored hash disagrees with the wrapper", async () => {
    const root = tmpEchoCatalog((m) => {
      (m.tools as Array<Record<string, unknown>>)[0].schemaHash = "deadbeef";
    });
    const index = buildIndex(root);
    await expect(assertNoDrift(index)).rejects.toMatchObject({ code: "manifest_drift" });
  });

  it("rejects with a GatewayError on drift (not a raw throw)", async () => {
    const root = tmpEchoCatalog((m) => {
      (m.tools as Array<Record<string, unknown>>)[0].schemaHash = "deadbeef";
    });
    const index = buildIndex(root);
    await expect(assertNoDrift(index)).rejects.toBeInstanceOf(GatewayError);
  });
});
