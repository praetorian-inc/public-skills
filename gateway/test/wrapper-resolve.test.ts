/**
 * SF-1 (unit portion) — resolveWrapperPath prefers .js over .ts.
 *
 * Contract guarded:
 *   - dir with BOTH wrapper.js and wrapper.ts → returns the .js path
 *   - dir with ONLY wrapper.ts               → returns the .ts path
 *   - dir with neither                        → returns undefined
 *
 * Uses real tmp dirs + real files so the real existsSync is exercised.
 * Disabling the guard (swapping js/ts preference) makes these tests fail.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWrapperPath, exportFromEntry } from "../src/execute/wrapper-resolve.js";

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wrapper-resolve-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

describe("resolveWrapperPath", () => {
  it("returns wrapper.js when BOTH wrapper.js and wrapper.ts exist", () => {
    const dir = makeTmp();
    writeFileSync(join(dir, "wrapper.js"), "// compiled");
    writeFileSync(join(dir, "wrapper.ts"), "// source");

    const result = resolveWrapperPath(dir);
    expect(result).toBe(join(dir, "wrapper.js"));
  });

  it("returns wrapper.ts when ONLY wrapper.ts exists", () => {
    const dir = makeTmp();
    writeFileSync(join(dir, "wrapper.ts"), "// source only");

    const result = resolveWrapperPath(dir);
    expect(result).toBe(join(dir, "wrapper.ts"));
  });

  it("returns wrapper.js when ONLY wrapper.js exists", () => {
    const dir = makeTmp();
    writeFileSync(join(dir, "wrapper.js"), "// compiled only");

    const result = resolveWrapperPath(dir);
    expect(result).toBe(join(dir, "wrapper.js"));
  });

  it("returns undefined when neither wrapper.js nor wrapper.ts exists", () => {
    const dir = makeTmp();
    expect(resolveWrapperPath(dir)).toBeUndefined();
  });
});

describe("exportFromEntry", () => {
  it("extracts the export name after the '#'", () => {
    expect(exportFromEntry("wrapper.js#echo")).toBe("echo");
    expect(exportFromEntry("wrapper.ts#myTool")).toBe("myTool");
  });

  it("returns the whole string when there is no '#'", () => {
    expect(exportFromEntry("echo")).toBe("echo");
    expect(exportFromEntry("myTool")).toBe("myTool");
  });
});
