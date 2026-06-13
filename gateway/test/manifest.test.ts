import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../src/catalog/manifest.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gw-manifest-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

const validManifest = {
  manifestVersion: 1,
  service: "echo",
  tools: [
    {
      id: "echo.echo",
      name: "echo",
      description: "Echo the input text back.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      outputSchema: { type: "object", properties: { text: { type: "string" } } },
      auth: [],
      entry: "wrapper.ts#echo",
    },
  ],
};

describe("loadManifest", () => {
  it("parses a valid manifest", () => {
    const p = write("valid.json", JSON.stringify(validManifest));
    const m = loadManifest(p);
    expect(m.service).toBe("echo");
    expect(m.manifestVersion).toBe(1);
    expect(m.tools).toHaveLength(1);
    expect(m.tools[0].id).toBe("echo.echo");
    expect(m.tools[0].entry).toBe("wrapper.ts#echo");
  });

  it("allows tools without an auth array (optional)", () => {
    const noAuth = structuredClone(validManifest);
    delete (noAuth.tools[0] as Record<string, unknown>).auth;
    const p = write("noauth.json", JSON.stringify(noAuth));
    expect(loadManifest(p).tools[0].auth).toBeUndefined();
  });

  it("rejects invalid JSON with a manifest_invalid error", () => {
    const p = write("badjson.json", "{ not json");
    expect(() => loadManifest(p)).toThrow(GatewayError);
    try {
      loadManifest(p);
    } catch (e) {
      expect((e as GatewayError).code).toBe("manifest_invalid");
    }
  });

  it("rejects a manifest missing required fields", () => {
    const p = write("missing.json", JSON.stringify({ manifestVersion: 1, service: "x" }));
    try {
      loadManifest(p);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("manifest_invalid");
    }
  });

  it("rejects an unknown manifestVersion major", () => {
    const v2 = { ...validManifest, manifestVersion: 2 };
    const p = write("v2.json", JSON.stringify(v2));
    try {
      loadManifest(p);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).code).toBe("manifest_invalid");
    }
  });

  it("rejects a tool entry missing the entry field", () => {
    const bad = structuredClone(validManifest);
    delete (bad.tools[0] as Record<string, unknown>).entry;
    const p = write("noentry.json", JSON.stringify(bad));
    expect(() => loadManifest(p)).toThrow(GatewayError);
  });
});
