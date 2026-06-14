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
    // The onepassword sub-object is always materialized (HIGH-1 fix: .default({}) not .optional())
    // even when provider is env, since Zod applies its own inner defaults regardless of provider.
    expect(cfg.catalog).toEqual({ root: "./.agentsmesh" });
    expect(cfg.search).toEqual({ ranker: "keyword" });
    expect(cfg.sandbox).toEqual({ memoryLimitMb: 128, timeoutMs: 5000 });
    expect(cfg.secrets.provider).toBe("env");
    // onepassword is now always present with its defaults (not undefined)
    expect(cfg.secrets.onepassword).toBeDefined();
  });

  it("defaults sandbox limits and accepts overrides (WS-1 §6.1)", () => {
    expect(loadConfig(writeConfig("sbx-def.yaml", `{}\n`)).sandbox).toEqual({
      memoryLimitMb: 128,
      timeoutMs: 5000,
    });
    const over = loadConfig(
      writeConfig("sbx-over.yaml", `sandbox:\n  memoryLimitMb: 64\n  timeoutMs: 2000\n`),
    );
    expect(over.sandbox).toEqual({ memoryLimitMb: 64, timeoutMs: 2000 });
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
    // New default template uses {item} not {key}
    expect(cfg.secrets.onepassword?.refTemplate).toBe("op://{vault}/{item}/{field}");
    expect(cfg.secrets.onepassword?.cliPath).toBe("op");
  });

  it("defaults account and field inside secrets.onepassword", () => {
    const p = writeConfig(
      "op-acct-field.yaml",
      `secrets:\n  provider: 1password\n  onepassword:\n    vault: Shared\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.secrets.onepassword?.account).toBe("praetorianlabs.1password.com");
    expect(cfg.secrets.onepassword?.field).toBe("password");
  });

  it("applies the ported default services table when onepassword is specified", () => {
    const p = writeConfig(
      "op-services.yaml",
      `secrets:\n  provider: 1password\n  onepassword:\n    vault: Shared\n`,
    );
    const cfg = loadConfig(p);
    const services = cfg.secrets.onepassword?.services;
    expect(services).toBeDefined();
    // Three live keys the catalog uses must be present in the default table
    expect(services?.["PERPLEXITY_API_KEY"]).toBeDefined();
    expect(services?.["PERPLEXITY_API_KEY"]?.item).toBe("Perplexity API Key");
    expect(services?.["FEATUREBASE_API_KEY"]).toBeDefined();
    expect(services?.["FEATUREBASE_API_KEY"]?.item).toBe("Featurebase API Key");
    // LINEAR_API_KEY is intentionally absent (no 1Password item in the marketplace SDK)
    expect(services?.["LINEAR_API_KEY"]).toBeUndefined();
  });

  it("resolves to the ported default services table when bare secrets:{provider:1password} is given", () => {
    const p = writeConfig("op-bare.yaml", `secrets:\n  provider: 1password\n`);
    const cfg = loadConfig(p);
    // HIGH-1 regression: bare config must materialize the onepassword sub-object
    // (.default({}) not .optional()) so the ported services table is present and
    // every keyed tool can resolve without throwing config_invalid.
    expect(cfg.secrets.onepassword).toBeDefined();
    const services = cfg.secrets.onepassword?.services;
    expect(services).toBeDefined();
    expect(services?.["PERPLEXITY_API_KEY"]).toBeDefined();
    expect(services?.["PERPLEXITY_API_KEY"]?.item).toBe("Perplexity API Key");
    expect(services?.["FEATUREBASE_API_KEY"]).toBeDefined();
    expect(services?.["FEATUREBASE_API_KEY"]?.item).toBe("Featurebase API Key");
    // LINEAR_API_KEY is intentionally absent from the default table
    expect(services?.["LINEAR_API_KEY"]).toBeUndefined();
  });

  it("superRefine rejects a services row with an empty item when provider is 1password", () => {
    const p = writeConfig(
      "op-empty-item.yaml",
      `secrets:\n  provider: 1password\n  onepassword:\n    services:\n      MY_KEY:\n        item: ""\n`,
    );
    expect(() => loadConfig(p)).toThrow();
  });

  it("superRefine accepts a services row with a non-empty item", () => {
    const p = writeConfig(
      "op-valid-item.yaml",
      `secrets:\n  provider: 1password\n  onepassword:\n    services:\n      MY_KEY:\n        item: My Item Title\n`,
    );
    expect(() => loadConfig(p)).not.toThrow();
  });

  it("superRefine does NOT reject an empty services row when provider is env", () => {
    // The superRefine only fires when provider = 1password
    const p = writeConfig(
      "env-empty-item.yaml",
      `secrets:\n  provider: env\n  onepassword:\n    services:\n      MY_KEY:\n        item: ""\n`,
    );
    expect(() => loadConfig(p)).not.toThrow();
  });
});
