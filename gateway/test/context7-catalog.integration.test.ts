/**
 * WS-A bulk port — integration proof that the ported Context7 tools are
 * first-class catalog citizens:
 *
 *  1. `buildIndex` over the REAL served catalog finds both tools.
 *  2. `assertNoDrift` passes (manifest schemaHash matches the live wrapper Zod).
 *  3. `executeTool` round-trips KEYLESS: auth: [] → EnvProvider resolves {} (no
 *     secret needed) → handler (injected fetch) → output.parse.
 *  4. A `run_code` round-trip: `caps.context7.resolve_library_id(args)` inside the
 *     V8 isolate returns the result.
 *
 * No real network: the wrapper's fetch is injected.
 */
import { describe, it, expect, afterEach } from "vitest";
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
} from "../../.agentsmesh/tools/context7/wrapper.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogRoot = join(here, "..", "..", ".agentsmesh");

const SEARCH_OK = {
  results: [{ id: "/facebook/react", title: "React", description: "UI library", totalSnippets: 1200 }],
};

const okFetch: FetchLike = async () =>
  new Response(JSON.stringify(SEARCH_OK), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

afterEach(() => __resetFetch());

describe("context7 catalog port — index + drift", () => {
  it("buildIndex finds both context7 tools in the served catalog", () => {
    const index = buildIndex(catalogRoot);
    expect(index.find((e) => e.id === "context7.resolve-library-id")?.kind).toBe("tool");
    expect(index.find((e) => e.id === "context7.get-library-docs")?.kind).toBe("tool");
  });

  it("assertNoDrift passes for the populated catalog", async () => {
    const index = buildIndex(catalogRoot);
    await expect(assertNoDrift(index)).resolves.toBeUndefined();
  });
});

describe("context7 catalog port — execute round-trip (keyless)", () => {
  it("executeTool runs keyless (no secret) and returns validated output", async () => {
    __setFetch(okFetch);
    const index = buildIndex(catalogRoot);
    const result = (await executeTool(
      "context7.resolve-library-id",
      { libraryName: "react" },
      { index, secrets: new EnvProvider() },
    )) as { totalResults: number; libraries: Array<{ id: string }> };

    expect(result.totalResults).toBe(1);
    expect(result.libraries[0].id).toBe("/facebook/react");
  });

  it("maps a bad arg to invalid_args via the runner", async () => {
    const index = buildIndex(catalogRoot);
    await expect(
      executeTool(
        "context7.resolve-library-id",
        { libraryName: "" },
        { index, secrets: new EnvProvider() },
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });
});

describe("context7 catalog port — run_code round-trip", () => {
  it("caps.context7.resolve_library_id(args) returns the result from inside the sandbox", async () => {
    __setFetch(okFetch);
    const index = buildIndex(catalogRoot);
    const sandbox = new Sandbox({ index, secrets: new EnvProvider() });

    const result = (await sandbox.run(
      `(() => {
        const r = caps.context7["resolve-library-id"]({ libraryName: "react" });
        return { count: r.totalResults, first: r.libraries[0].id };
      })()`,
    )) as { count: number; first: string };

    expect(result).toEqual({ count: 1, first: "/facebook/react" });
  });
});
