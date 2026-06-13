/**
 * Group I — search.embedding config schema + cross-refinement.
 *
 * - search.embedding is optional with defaults (empty config stays valid).
 * - defaults: backend default is "api" (O2 — `local` is unwired in P1, so
 *   defaulting to it would make semantic/hybrid dead-on-arrival). The embedding
 *   sub-object is only read for semantic/hybrid. Verify field defaults
 *   (dimensions, cacheDir, backend).
 * - cross-refinement: ranker ∈ {semantic,hybrid} + backend=api ⇒ endpoint
 *   REQUIRED → config_invalid (a Zod error) when absent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gw-config-emb-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

describe("loadConfig — search.embedding (WS-3)", () => {
  it("leaves search.embedding undefined when omitted (empty config still valid)", () => {
    const p = writeConfig("no-emb.yaml", `{}\n`);
    const cfg = loadConfig(p);
    expect(cfg.search.embedding).toBeUndefined();
  });

  it("applies field defaults inside search.embedding", () => {
    const p = writeConfig(
      "emb-defaults.yaml",
      `search:\n  ranker: semantic\n  embedding:\n    backend: api\n    endpoint: https://api.example.com/v1/embeddings\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.search.embedding?.backend).toBe("api");
    expect(cfg.search.embedding?.dimensions).toBe(384);
    expect(cfg.search.embedding?.cacheDir).toBe("./.gateway-cache/embeddings");
  });

  it("defaults embedding.backend to api (O2; local is unwired in P1)", () => {
    // ranker: keyword exempts the api-endpoint cross-refinement, so this isolates
    // the backend DEFAULT. Would be RED if the default were "local" (the H2 bug).
    const p = writeConfig(
      "emb-backend-default.yaml",
      `search:\n  ranker: keyword\n  embedding:\n    model: some-model\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.search.embedding?.backend).toBe("api");
  });

  it("accepts a full api embedding sub-config", () => {
    const p = writeConfig(
      "emb-full.yaml",
      `search:\n  ranker: hybrid\n  embedding:\n    backend: api\n    model: text-embedding-3-small\n    endpoint: https://api.example.com/v1/embeddings\n    apiKeyEnv: EMBED_KEY\n    dimensions: 1536\n    cacheDir: ./cache\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.search.embedding).toEqual({
      backend: "api",
      model: "text-embedding-3-small",
      endpoint: "https://api.example.com/v1/embeddings",
      apiKeyEnv: "EMBED_KEY",
      dimensions: 1536,
      cacheDir: "./cache",
    });
  });

  it("rejects semantic + backend api WITHOUT an endpoint (cross-refinement)", () => {
    const p = writeConfig(
      "emb-no-endpoint.yaml",
      `search:\n  ranker: semantic\n  embedding:\n    backend: api\n`,
    );
    expect(() => loadConfig(p)).toThrow(/endpoint/i);
  });

  it("rejects hybrid + backend api WITHOUT an endpoint (cross-refinement)", () => {
    const p = writeConfig(
      "emb-hybrid-no-endpoint.yaml",
      `search:\n  ranker: hybrid\n  embedding:\n    backend: api\n`,
    );
    expect(() => loadConfig(p)).toThrow(/endpoint/i);
  });

  it("does NOT require endpoint for keyword + backend api (embedding unused)", () => {
    const p = writeConfig(
      "emb-keyword-ok.yaml",
      `search:\n  ranker: keyword\n  embedding:\n    backend: api\n`,
    );
    // keyword never reads embedding, so an absent endpoint must not fail load.
    expect(() => loadConfig(p)).not.toThrow();
  });

  it("does NOT require endpoint for semantic + backend local", () => {
    const p = writeConfig(
      "emb-local-ok.yaml",
      `search:\n  ranker: semantic\n  embedding:\n    backend: local\n`,
    );
    expect(() => loadConfig(p)).not.toThrow();
  });
});
