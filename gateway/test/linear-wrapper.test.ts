/**
 * A0-CATALOG spike — TDD for the ported `linear.list_issues` ToolDescriptor.
 *
 * Proves the §6.2 adapter rules end-to-end for ONE real marketplace tool:
 *  - input validation rejects bad args (so the runner maps to `invalid_args`),
 *  - output validation shape is honoured,
 *  - the handler is CTX-only: it builds the Linear request from
 *    `ctx.secrets.LINEAR_API_KEY` and an INJECTED fetch (never a real network call,
 *    never an env read), sending the key in the `Authorization` header.
 *
 * The catalog wrapper lives at ../../.agentsmesh/tools/linear/wrapper.ts; the
 * transport is injected via `__setFetch` so no real HTTP happens in tests.
 */
import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import {
  listIssues,
  __setFetch,
  __resetFetch,
  type FetchLike,
} from "../../.agentsmesh/tools/linear/wrapper.js";

/** Build a fake fetch that records the request and returns a canned GraphQL body. */
function fakeFetch(body: unknown, captured: { url?: string; init?: RequestInit } = {}): FetchLike {
  return async (url, init) => {
    captured.url = url;
    captured.init = init;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const GRAPHQL_OK = {
  data: {
    issues: {
      nodes: [
        {
          id: "iss_1",
          identifier: "ENG-1",
          title: "First issue",
          description: "a".repeat(500),
          priority: 2,
          priorityLabel: "High",
          state: { id: "st_1", name: "In Progress", type: "started" },
          assignee: { id: "u_1", name: "Ada" },
          creator: { id: "u_2", name: "Bob" },
          url: "https://linear.app/x/issue/ENG-1",
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

afterEach(() => __resetFetch());

describe("linear.list_issues descriptor shape (adapter rules)", () => {
  it("is a ToolDescriptor with id/name/input/output/auth/handler", () => {
    expect(listIssues.id).toBe("linear.list_issues");
    expect(typeof listIssues.name).toBe("string");
    expect(listIssues.auth).toEqual(["LINEAR_API_KEY"]);
    expect(listIssues.input).toBeInstanceOf(z.ZodType);
    expect(listIssues.output).toBeInstanceOf(z.ZodType);
    expect(typeof listIssues.handler).toBe("function");
  });
});

describe("linear.list_issues input validation", () => {
  it("rejects a command-injection sequence in a filter field", () => {
    const parsed = listIssues.input.safeParse({ team: "Eng; rm -rf /" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a limit above the allowed maximum", () => {
    const parsed = listIssues.input.safeParse({ limit: 9999 });
    expect(parsed.success).toBe(false);
  });

  it("accepts a clean filter (limit left optional; default applied in handler)", () => {
    const parsed = listIssues.input.parse({ team: "Engineering" });
    expect(parsed).toMatchObject({ team: "Engineering" });
    expect(parsed.limit).toBeUndefined();
  });
});

describe("linear.list_issues handler (CTX-only, injected transport)", () => {
  it("sends the secret in the Authorization header to the Linear GraphQL endpoint", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(fakeFetch(GRAPHQL_OK, captured));

    await listIssues.handler(
      { team: "Engineering" },
      { secrets: { LINEAR_API_KEY: "lin_api_test123" } },
    );

    expect(captured.url).toBe("https://api.linear.app/graphql");
    expect(captured.init?.method).toBe("POST");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("lin_api_test123");
    expect(headers["content-type"] ?? headers["Content-Type"]).toContain("application/json");
  });

  it("maps GraphQL nodes to the output schema and truncates description to 200 chars", async () => {
    __setFetch(fakeFetch(GRAPHQL_OK));

    const out = await listIssues.handler(
      { team: "Engineering" },
      { secrets: { LINEAR_API_KEY: "lin_api_test123" } },
    );

    const parsed = listIssues.output.parse(out);
    expect(parsed.totalIssues).toBe(1);
    expect(parsed.issues[0]).toMatchObject({
      id: "iss_1",
      identifier: "ENG-1",
      title: "First issue",
      assignee: "Ada",
      assigneeId: "u_1",
      creator: "Bob",
      status: "In Progress",
    });
    expect(parsed.issues[0].description?.length).toBe(200);
    expect(typeof parsed.estimatedTokens).toBe("number");
  });

  it("applies the default limit of 50 in the GraphQL variables when none is given", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(fakeFetch(GRAPHQL_OK, captured));

    await listIssues.handler({}, { secrets: { LINEAR_API_KEY: "k" } });

    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.variables.first).toBe(50);
    expect(body.variables.orderBy).toBe("updatedAt");
  });

  it("returns an empty issues array when the API returns no nodes", async () => {
    __setFetch(fakeFetch({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } }));

    const out = listIssues.output.parse(
      await listIssues.handler({}, { secrets: { LINEAR_API_KEY: "k" } }),
    );
    expect(out.issues).toEqual([]);
    expect(out.totalIssues).toBe(0);
  });

  it("throws when the GraphQL response carries errors", async () => {
    __setFetch(fakeFetch({ errors: [{ message: "Authentication required" }] }));

    await expect(
      listIssues.handler({}, { secrets: { LINEAR_API_KEY: "bad" } }),
    ).rejects.toThrow(/Authentication required/);
  });
});
