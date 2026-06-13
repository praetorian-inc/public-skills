import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gw-config-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

describe("loadConfig", () => {
  it("parses the sample config shape", () => {
    const p = writeConfig(
      "full.yaml",
      `catalog:\n  root: ./.agentsmesh\nsearch:\n  ranker: keyword\nsecrets:\n  provider: env\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg).toEqual({
      catalog: { root: "./.agentsmesh" },
      search: { ranker: "keyword" },
      secrets: { provider: "env" },
    });
  });

  it("applies defaults when sections are omitted", () => {
    const p = writeConfig("empty.yaml", `{}\n`);
    const cfg = loadConfig(p);
    expect(cfg.catalog.root).toBe("./.agentsmesh");
    expect(cfg.search.ranker).toBe("keyword");
    expect(cfg.secrets.provider).toBe("env");
  });

  it("applies defaults for partially-specified config", () => {
    const p = writeConfig("partial.yaml", `catalog:\n  root: ./custom\n`);
    const cfg = loadConfig(p);
    expect(cfg.catalog.root).toBe("./custom");
    expect(cfg.search.ranker).toBe("keyword");
    expect(cfg.secrets.provider).toBe("env");
  });

  it("accepts each valid ranker enum value", () => {
    for (const ranker of ["keyword", "semantic", "hybrid"]) {
      const p = writeConfig(`ranker-${ranker}.yaml`, `search:\n  ranker: ${ranker}\n`);
      expect(loadConfig(p).search.ranker).toBe(ranker);
    }
  });

  it("accepts each valid secrets provider enum value", () => {
    for (const provider of ["env", "1password"]) {
      const p = writeConfig(`prov-${provider}.yaml`, `secrets:\n  provider: ${provider}\n`);
      expect(loadConfig(p).secrets.provider).toBe(provider);
    }
  });

  it("rejects an invalid ranker enum value", () => {
    const p = writeConfig("bad-ranker.yaml", `search:\n  ranker: fuzzy\n`);
    expect(() => loadConfig(p)).toThrow();
  });

  it("rejects an invalid secrets provider enum value", () => {
    const p = writeConfig("bad-prov.yaml", `secrets:\n  provider: vault\n`);
    expect(() => loadConfig(p)).toThrow();
  });

  it("throws a clear error when the file does not exist", () => {
    expect(() => loadConfig(join(dir, "does-not-exist.yaml"))).toThrow();
  });

  it("parses an optional secrets.onepassword sub-object", () => {
    const p = writeConfig(
      "op.yaml",
      `secrets:\n  provider: 1password\n  onepassword:\n    vault: Engineering\n    cliPath: /usr/local/bin/op\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.secrets.provider).toBe("1password");
    expect(cfg.secrets.onepassword?.vault).toBe("Engineering");
    expect(cfg.secrets.onepassword?.cliPath).toBe("/usr/local/bin/op");
  });

  it("defaults refTemplate and cliPath inside secrets.onepassword", () => {
    const p = writeConfig(
      "op-defaults.yaml",
      `secrets:\n  provider: 1password\n  onepassword:\n    vault: Shared\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.secrets.onepassword?.refTemplate).toBe("op://{vault}/{key}/password");
    expect(cfg.secrets.onepassword?.cliPath).toBe("op");
  });

  it("leaves secrets.onepassword undefined when omitted", () => {
    const p = writeConfig("op-absent.yaml", `secrets:\n  provider: 1password\n`);
    const cfg = loadConfig(p);
    expect(cfg.secrets.onepassword).toBeUndefined();
  });
});
