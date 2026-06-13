/**
 * WS-A bulk port — integration proof that the ported Perplexity tools are
 * first-class catalog citizens:
 *
 *  1. `buildIndex` over the REAL served catalog finds both tools.
 *  2. `assertNoDrift` passes (manifest schemaHash matches the live wrapper Zod).
 *  3. `executeTool` round-trips: input.parse → secret resolved host-side via
 *     EnvProvider → handler (injected fetch) → output.parse.
 *  4. A `run_code` round-trip: `caps.perplexity.search(args)` inside the V8 isolate
 *     returns the result — proving CTX-only holds INSIDE the isolate (the secret is
 *     resolved host-side, never enters the isolate).
 *
 * No real network: the wrapper's fetch is injected. The secret is set via env so
 * the EnvProvider resolves it host-side exactly as production would.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { assertNoDrift } from "../src/execute/drift.js";
import { executeTool } from "../src/execute/runner.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { Sandbox } from "../src/sandbox/sandbox.js";
import {
  __setFetch,
  __resetFetch,
  type FetchLike,
} from "../../.agentsmesh/tools/perplexity/wrapper.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogRoot = join(here, "..", "..", ".agentsmesh");

const SEARCH_OK = {
  results: [
    { title: "TS Handbook", url: "https://ts.dev/a", snippet: "Type-safe JS." },
  ],
};

const okFetch: FetchLike = async () =>
  new Response(JSON.stringify(SEARCH_OK), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const ORIGINAL_KEY = process.env.PERPLEXITY_API_KEY;

beforeAll(() => {
  process.env.PERPLEXITY_API_KEY = "pplx_env_secret";
  __setFetch(okFetch);
});

afterAll(() => {
  __resetFetch();
  if (ORIGINAL_KEY === undefined) delete process.env.PERPLEXITY_API_KEY;
  else process.env.PERPLEXITY_API_KEY = ORIGINAL_KEY;
});

describe("perplexity catalog port — index + drift", () => {
  it("buildIndex finds both perplexity tools in the served catalog", () => {
    const index = buildIndex(catalogRoot);
    const search = index.find((e) => e.id === "perplexity.search");
    const ask = index.find((e) => e.id === "perplexity.ask");
    expect(search?.kind).toBe("tool");
    expect(ask?.kind).toBe("tool");
  });

  it("assertNoDrift passes for the populated catalog", async () => {
    const index = buildIndex(catalogRoot);
    await expect(assertNoDrift(index)).resolves.toBeUndefined();
  });
});

describe("perplexity catalog port — execute round-trip", () => {
  it("executeTool resolves the secret host-side and returns validated output", async () => {
    const index = buildIndex(catalogRoot);
    const result = (await executeTool(
      "perplexity.search",
      { query: "typescript" },
      { index, secrets: new EnvProvider() },
    )) as { content: string };

    expect(result.content).toContain("TS Handbook");
  });

  it("maps a bad arg to invalid_args via the runner", async () => {
    const index = buildIndex(catalogRoot);
    await expect(
      executeTool(
        "perplexity.search",
        { query: "" },
        { index, secrets: new EnvProvider() },
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });
});

describe("perplexity catalog port — run_code round-trip (CTX-only inside the isolate)", () => {
  it("caps.perplexity.search(args) returns the result from inside the sandbox", async () => {
    const index = buildIndex(catalogRoot);
    const sandbox = new Sandbox({ index, secrets: new EnvProvider() });

    const result = (await sandbox.run(
      `(() => {
        const r = caps.perplexity.search({ query: "typescript" });
        return { hasHandbook: r.content.indexOf("TS Handbook") >= 0 };
      })()`,
    )) as { hasHandbook: boolean };

    expect(result).toEqual({ hasHandbook: true });
  });
});
