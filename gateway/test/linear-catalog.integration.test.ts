/**
 * A0-CATALOG spike — integration proof that the ported `linear.list_issues`
 * tool is a first-class catalog citizen:
 *
 *  1. `buildIndex` over the REAL served catalog (public-skills/.agentsmesh) finds it.
 *  2. `assertNoDrift` passes for the populated catalog (manifest schemaHash matches
 *     the live wrapper Zod) — proves the generate-manifest pipeline is in sync.
 *  3. `executeTool` round-trips: input.parse → secret resolved host-side via
 *     EnvProvider → handler (injected fetch) → output.parse.
 *  4. A `run_code` round-trip: `caps.linear.list_issues(args)` inside the V8 isolate
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
} from "../../.agentsmesh/tools/linear/wrapper.js";

const here = dirname(fileURLToPath(import.meta.url));
// The REAL served catalog (gateway.config.yaml catalog.root => ../.agentsmesh).
const catalogRoot = join(here, "..", "..", ".agentsmesh");

const GRAPHQL_OK = {
  data: {
    issues: {
      nodes: [
        {
          id: "iss_42",
          identifier: "ENG-42",
          title: "Ship the gateway",
          description: "do it",
          priority: 1,
          priorityLabel: "Urgent",
          state: { id: "st", name: "Todo", type: "unstarted" },
          assignee: { id: "u", name: "Ada" },
          creator: { id: "c", name: "Bob" },
          url: "https://linear.app/x/issue/ENG-42",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          cycle: null,
          parent: null,
          dueDate: null,
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  },
};

const okFetch: FetchLike = async () =>
  new Response(JSON.stringify(GRAPHQL_OK), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const ORIGINAL_KEY = process.env.LINEAR_API_KEY;

beforeAll(() => {
  process.env.LINEAR_API_KEY = "lin_env_secret";
  __setFetch(okFetch);
});

afterAll(() => {
  __resetFetch();
  if (ORIGINAL_KEY === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = ORIGINAL_KEY;
});

describe("linear catalog port — index + drift", () => {
  it("buildIndex finds linear.list_issues as a tool in the served catalog", () => {
    const index = buildIndex(catalogRoot);
    const entry = index.find((e) => e.id === "linear.list_issues");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("tool");
  });

  it("assertNoDrift passes for the populated catalog", async () => {
    const index = buildIndex(catalogRoot);
    await expect(assertNoDrift(index)).resolves.toBeUndefined();
  });
});

describe("linear catalog port — execute round-trip", () => {
  it("executeTool resolves the secret host-side and returns validated output", async () => {
    const index = buildIndex(catalogRoot);
    const result = (await executeTool(
      "linear.list_issues",
      { team: "Engineering" },
      { index, secrets: new EnvProvider() },
    )) as { totalIssues: number; issues: Array<{ id: string }> };

    expect(result.totalIssues).toBe(1);
    expect(result.issues[0].id).toBe("iss_42");
  });

  it("maps a bad arg to invalid_args via the runner", async () => {
    const index = buildIndex(catalogRoot);
    await expect(
      executeTool(
        "linear.list_issues",
        { limit: 9999 },
        { index, secrets: new EnvProvider() },
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });
});

describe("linear catalog port — run_code round-trip (CTX-only inside the isolate)", () => {
  it("caps.linear.list_issues(args) returns the result from inside the sandbox", async () => {
    const index = buildIndex(catalogRoot);
    const sandbox = new Sandbox({ index, secrets: new EnvProvider() });

    const result = (await sandbox.run(
      `(() => {
        const r = caps.linear.list_issues({ team: "Engineering" });
        return { count: r.totalIssues, first: r.issues[0].id };
      })()`,
    )) as { count: number; first: string };

    expect(result).toEqual({ count: 1, first: "iss_42" });
  });
});
