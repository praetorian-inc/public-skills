import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { generateManifest, schemaHash } from "../scripts/generate-manifest.js";
import { loadManifest } from "../src/catalog/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const echoWrapper = join(here, "fixtures/.agentsmesh/tools/echo/wrapper.ts");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Copy the echo fixture wrapper into a throwaway service dir under tmp. */
function tmpServiceFromEcho(): string {
  const root = mkdtempSync(join(tmpdir(), "gw-genmanifest-"));
  tmpDirs.push(root);
  const svc = join(root, "echo");
  mkdirSync(svc, { recursive: true });
  copyFileSync(echoWrapper, join(svc, "wrapper.ts"));
  return svc;
}

describe("generateManifest", () => {
  it("emits a valid manifest with the right service and one echo tool", async () => {
    const svc = tmpServiceFromEcho();
    const manifest = await generateManifest(svc);

    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.service).toBe("echo");
    expect(manifest.tools).toHaveLength(1);

    const tool = manifest.tools[0];
    expect(tool.id).toBe("echo.echo");
    expect(tool.name).toBe("echo");
    expect(tool.entry).toBe("wrapper.ts#echo");
  });

  it("emits JSON-Schema input/output describing the `text` field", async () => {
    const svc = tmpServiceFromEcho();
    const manifest = await generateManifest(svc);
    const tool = manifest.tools[0];

    const inputProps = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
    const outputProps = (tool.outputSchema as { properties?: Record<string, unknown> }).properties;
    expect(inputProps).toHaveProperty("text");
    expect(outputProps).toHaveProperty("text");
  });

  it("writes manifest.json to the service dir", async () => {
    const svc = tmpServiceFromEcho();
    await generateManifest(svc);
    const written = loadManifest(join(svc, "manifest.json"));
    expect(written.service).toBe("echo");
    expect(written.tools[0].id).toBe("echo.echo");
  });

  it("produces a non-empty schemaHash that is stable across two runs", async () => {
    const svc1 = tmpServiceFromEcho();
    const svc2 = tmpServiceFromEcho();
    const m1 = await generateManifest(svc1);
    const m2 = await generateManifest(svc2);

    const h1 = (m1.tools[0] as { schemaHash: string }).schemaHash;
    const h2 = (m2.tools[0] as { schemaHash: string }).schemaHash;
    expect(h1).toBeTruthy();
    expect(h1.length).toBeGreaterThan(0);
    expect(h1).toBe(h2);
  });

  it("changes schemaHash when the zod schema changes", () => {
    const before = schemaHash(z.object({ text: z.string() }), z.object({ text: z.string() }));
    const after = schemaHash(
      z.object({ text: z.string(), extra: z.number() }),
      z.object({ text: z.string() }),
    );
    expect(before).not.toBe(after);
  });

  it("computes the same hash for the same schema (recomputable by Group C / CI)", () => {
    const a = schemaHash(z.object({ text: z.string() }), z.object({ text: z.string() }));
    const b = schemaHash(z.object({ text: z.string() }), z.object({ text: z.string() }));
    expect(a).toBe(b);
  });
});
