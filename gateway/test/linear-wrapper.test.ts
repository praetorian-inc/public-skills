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

// ════════════════════════════════════════════════════════════════════════════
// NEW: Ported tools — behavioral tests for the 57 remaining Linear tools.
// Coverage matrix (plan §6): descriptor shape, CTX-only auth, input rejection,
// output mapping/estimatedTokens, mutation body, delete shape, error
// sanitization, resolver-layer (MANDATORY), cycle-orchestration (MANDATORY).
// One multi-call fakeFetch helper for resolver/cycle tests.
// ════════════════════════════════════════════════════════════════════════════

import {
  getIssue,
  createIssue,
  updateIssue,
  archiveIssue,
  listProjects,
  createProject,
  deleteProject,
  listCycles,
  createCycle,
  listTeams,
  findUser,
  listComments,
  createComment,
  listLabels,
  createLabel,
  deleteLabel,
  listWorkflowStates,
  createWorkflowState,
  listAttachments,
  deleteAttachment,
  createReaction,
  deleteReaction,
  createInitiative,
  listInitiatives,
  deleteInitiative,
  listDocuments,
  createDocument,
  updateDocument,
  listIssueRelations,
  createIssueRelation,
  deleteIssueRelation,
} from "../../.agentsmesh/tools/linear/wrapper.js";

/**
 * Build a multi-call fake fetch. Each call pops the next canned response off the queue.
 * captured is an array of { url, init } entries in call order.
 */
function multiCallFetch(
  responses: unknown[],
  captured: Array<{ url?: string; init?: RequestInit }> = [],
): FetchLike {
  let idx = 0;
  return async (url, init) => {
    const slot: { url?: string; init?: RequestInit } = {};
    captured.push(slot);
    slot.url = url;
    slot.init = init;
    const body = responses[idx] ?? { data: {} };
    idx++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Envelope that makes linearGraphQL throw on HTTP error. */
function fakeHttpError(status: number): FetchLike {
  return async () =>
    new Response(JSON.stringify({ error: "server error" }), {
      status,
      headers: { "content-type": "application/json" },
    });
}

// ── CamelCase id existence (MANDATORY per plan §4) ────────────────────────

describe("camelCase document tool ids exist verbatim (plan §4 fidelity)", () => {
  it("linear.createDocument id is camelCase (not snake_case)", () => {
    expect(createDocument.id).toBe("linear.createDocument");
  });

  it("linear.updateDocument id is camelCase (not snake_case)", () => {
    expect(updateDocument.id).toBe("linear.updateDocument");
  });

  it("linear.documents id is NOT 'linear.list_documents'", () => {
    expect(listDocuments.id).toBe("linear.documents");
  });
});

// ── Issues family ─────────────────────────────────────────────────────────

describe("linear.get_issue descriptor + output mapping", () => {
  it("has the right id, auth=LINEAR_API_KEY, ZodType input/output, function handler", () => {
    expect(getIssue.id).toBe("linear.get_issue");
    expect(getIssue.auth).toEqual(["LINEAR_API_KEY"]);
    expect(getIssue.input).toBeInstanceOf(z.ZodType);
    expect(getIssue.output).toBeInstanceOf(z.ZodType);
    expect(typeof getIssue.handler).toBe("function");
  });

  it("maps a canned issue response to output schema, sets estimatedTokens", async () => {
    const GQL_ISSUE = {
      data: {
        issue: {
          id: "iss_abc",
          identifier: "ENG-42",
          title: "Fix the bug",
          description: "a".repeat(600),
          priority: 1,
          priorityLabel: "Urgent",
          state: { id: "st_2", name: "Todo", type: "unstarted" },
          assignee: { id: "u_3", name: "Carol", email: "carol@example.com" },
          project: null,
          cycle: null,
          parent: null,
          dueDate: null,
          url: "https://linear.app/x/issue/ENG-42",
          branchName: "eng-42-fix-the-bug",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          estimate: null,
          attachments: { nodes: [] },
        },
      },
    };
    __setFetch(fakeFetch(GQL_ISSUE));

    const out = getIssue.output.parse(
      await getIssue.handler({ id: "iss_abc" }, { secrets: { LINEAR_API_KEY: "k" } }),
    );

    expect(out.id).toBe("iss_abc");
    expect(out.identifier).toBe("ENG-42");
    expect(out.title).toBe("Fix the bug");
    // description truncated to 500 chars (fullDescription not passed)
    expect(out.description?.length).toBe(500);
    expect(typeof out.estimatedTokens).toBe("number");
  });

  it("rejects a control-char sequence in the id field", () => {
    expect(getIssue.input.safeParse({ id: "abcdef" }).success).toBe(false);
  });

  it("throws 'Linear API HTTP 403' on an HTTP error response", async () => {
    __setFetch(fakeHttpError(403));
    await expect(
      getIssue.handler({ id: "iss_abc" }, { secrets: { LINEAR_API_KEY: "k" } }),
    ).rejects.toThrow("Linear API HTTP 403");
  });
});

describe("linear.archive_issue — simple mutation + GraphQL error path", () => {
  it("sends POST to graphql endpoint with issue id in mutation variables", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const ARCHIVE_OK = {
      data: {
        issueArchive: {
          success: true,
          entity: { id: "iss_xyz", identifier: "ENG-9", archivedAt: "2026-01-01T00:00:00.000Z" },
        },
      },
    };
    __setFetch(fakeFetch(ARCHIVE_OK, captured));

    await archiveIssue.handler(
      { id: "iss_xyz" },
      { secrets: { LINEAR_API_KEY: "lin_k" } },
    );

    expect(captured.url).toBe("https://api.linear.app/graphql");
    expect(captured.init?.method).toBe("POST");
    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.variables.id).toBe("iss_xyz");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("lin_k");
  });

  it("rejects GraphQL errors with the upstream message", async () => {
    __setFetch(
      fakeFetch({ errors: [{ message: "Issue not found" }] }),
    );
    await expect(
      archiveIssue.handler({ issueId: "nope" }, { secrets: { LINEAR_API_KEY: "k" } }),
    ).rejects.toThrow(/Issue not found/);
  });
});

// ── MANDATORY resolver-layer test: create_issue team-name → UUID ─────────

describe("linear.create_issue — MANDATORY resolver-layer (team NAME → UUID)", () => {
  /**
   * Two-call fetch sequence:
   *   Call 1: TeamsForResolution query → resolveTeamId("Engineering") → "team_uuid_999"
   *   Call 2: issueCreate mutation → returns created issue
   */
  it("resolves team name to UUID before issuing the create mutation", async () => {
    const TEAMS_RESPONSE = {
      data: {
        teams: {
          nodes: [
            { id: "team_uuid_999", name: "Engineering", key: "ENG" },
            { id: "team_uuid_000", name: "Design", key: "DES" },
          ],
        },
      },
    };
    const CREATE_RESPONSE = {
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: "iss_new_1",
            identifier: "ENG-100",
            title: "New issue via test",
            url: "https://linear.app/x/issue/ENG-100",
          },
        },
      },
    };

    const captured: Array<{ url?: string; init?: RequestInit }> = [];
    __setFetch(multiCallFetch([TEAMS_RESPONSE, CREATE_RESPONSE], captured));

    const out = await createIssue.handler(
      { title: "New issue via test", team: "Engineering" },
      { secrets: { LINEAR_API_KEY: "lin_k" } },
    );

    // Two calls were made (resolve teams, then create)
    expect(captured.length).toBeGreaterThanOrEqual(2);

    // The issueCreate mutation body must carry the resolved UUID, not the string "Engineering"
    const createCall = captured[captured.length - 1];
    const createBody = JSON.parse((createCall.init?.body as string) ?? "{}");
    expect(createBody.variables.input.teamId).toBe("team_uuid_999");
    expect(createBody.variables.input.teamId).not.toBe("Engineering");

    // Output shape is correct
    const parsed = createIssue.output.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.issue.id).toBe("iss_new_1");
    expect(typeof parsed.estimatedTokens).toBe("number");
  });

  it("resolves assignee 'me' via viewer query → UUID in create mutation", async () => {
    const TEAMS_RESPONSE = {
      data: {
        teams: { nodes: [{ id: "t_1", name: "Engineering", key: "ENG" }] },
      },
    };
    const VIEWER_RESPONSE = {
      data: { viewer: { id: "viewer_uuid_abc" } },
    };
    const CREATE_RESPONSE = {
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: "iss_new_2",
            identifier: "ENG-101",
            title: "Assigned to me",
            url: "https://linear.app/x/issue/ENG-101",
          },
        },
      },
    };

    const captured: Array<{ url?: string; init?: RequestInit }> = [];
    __setFetch(multiCallFetch([TEAMS_RESPONSE, VIEWER_RESPONSE, CREATE_RESPONSE], captured));

    await createIssue.handler(
      { title: "Assigned to me", team: "Engineering", assignee: "me" },
      { secrets: { LINEAR_API_KEY: "k" } },
    );

    // The issueCreate mutation body must carry the viewer UUID as assigneeId
    const createCall = captured[captured.length - 1];
    const createBody = JSON.parse((createCall.init?.body as string) ?? "{}");
    expect(createBody.variables.input.assigneeId).toBe("viewer_uuid_abc");
    expect(createBody.variables.input.assigneeId).not.toBe("me");
  });
});

// ── MANDATORY cycle-orchestration test ────────────────────────────────────

describe("linear.create_issue — MANDATORY cycle orchestration (2-call pattern)", () => {
  /**
   * When `cycle` is provided, create_issue must:
   *   1. resolveTeamId → teams query (call 1)
   *   2. issueCreate mutation (call 2)
   *   3. issueUpdate mutation to assign cycle (call 3)
   */
  it("fires issueCreate then issueUpdate to assign cycle when cycle is provided", async () => {
    const TEAMS_RESPONSE = {
      data: {
        teams: { nodes: [{ id: "t_eng", name: "Engineering", key: "ENG" }] },
      },
    };
    const CREATE_RESPONSE = {
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: "iss_cycle_1",
            identifier: "ENG-200",
            title: "Cycled issue",
            url: "https://linear.app/x/issue/ENG-200",
          },
        },
      },
    };
    // issueUpdate for cycle: minimal valid response
    const UPDATE_RESPONSE = {
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "iss_cycle_1",
            identifier: "ENG-200",
            title: "Cycled issue",
            url: "https://linear.app/x/issue/ENG-200",
            project: null,
          },
        },
      },
    };

    const captured: Array<{ url?: string; init?: RequestInit }> = [];
    __setFetch(multiCallFetch([TEAMS_RESPONSE, CREATE_RESPONSE, UPDATE_RESPONSE], captured));

    const out = await createIssue.handler(
      { title: "Cycled issue", team: "Engineering", cycle: "cycle_uuid_123" },
      { secrets: { LINEAR_API_KEY: "k" } },
    );

    // Must fire at least 3 calls: teams, create, update
    expect(captured.length).toBeGreaterThanOrEqual(3);

    // The issueCreate body (2nd call, after teams) must NOT include cycle in input
    const createCall = captured[1];
    const createBody = JSON.parse((createCall.init?.body as string) ?? "{}");
    expect(createBody.variables.input.cycle).toBeUndefined();

    // The issueUpdate body (3rd call) must carry the cycle id
    const updateCall = captured[2];
    const updateBody = JSON.parse((updateCall.init?.body as string) ?? "{}");
    expect(updateBody.variables.input.cycleId ?? updateBody.variables.input.cycle).toBe(
      "cycle_uuid_123",
    );

    // Output is still a valid createIssue output
    const parsed = createIssue.output.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.issue.identifier).toBe("ENG-200");
  });
});

// ── Projects family ───────────────────────────────────────────────────────

describe("linear.list_projects — list shape + CTX-only auth", () => {
  it("descriptor: id/auth/Zod input-output/handler", () => {
    expect(listProjects.id).toBe("linear.list_projects");
    expect(listProjects.auth).toEqual(["LINEAR_API_KEY"]);
    expect(listProjects.input).toBeInstanceOf(z.ZodType);
    expect(listProjects.output).toBeInstanceOf(z.ZodType);
    expect(typeof listProjects.handler).toBe("function");
  });

  it("maps project list + sets estimatedTokens", async () => {
    const PROJECTS_OK = {
      data: {
        projects: {
          nodes: [
            {
              id: "proj_1",
              name: "Alpha",
              description: "First project",
              slugId: "alpha-slug",
              color: "#ff0000",
              status: { type: "started" },
              state: "started",
              progress: 0.5,
              lead: { id: "u_1", name: "Alice" },
              teams: { nodes: [{ id: "t_1", name: "Engineering" }] },
              url: "https://linear.app/proj/alpha",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
              startDate: null,
              targetDate: null,
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    __setFetch(fakeFetch(PROJECTS_OK));

    const out = listProjects.output.parse(
      await listProjects.handler({}, { secrets: { LINEAR_API_KEY: "k" } }),
    );

    expect(out.projects[0].id).toBe("proj_1");
    expect(out.projects[0].name).toBe("Alpha");
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

describe("linear.create_project — mutation variables + resolver", () => {
  it("resolves team name and sends teamIds in mutation body", async () => {
    const TEAMS_RESPONSE = {
      data: {
        teams: { nodes: [{ id: "t_eng", name: "Engineering", key: "ENG" }] },
      },
    };
    const CREATE_PROJ_RESPONSE = {
      data: {
        projectCreate: {
          success: true,
          project: {
            id: "proj_new",
            name: "My Project",
            slugId: "my-project",
            url: "https://linear.app/proj/my-project",
            state: "planned",
          },
        },
      },
    };

    const captured: Array<{ url?: string; init?: RequestInit }> = [];
    __setFetch(multiCallFetch([TEAMS_RESPONSE, CREATE_PROJ_RESPONSE], captured));

    await createProject.handler(
      { name: "My Project", team: "Engineering" },
      { secrets: { LINEAR_API_KEY: "k" } },
    );

    // The projectCreate mutation must carry the resolved team UUID
    const createCall = captured[captured.length - 1];
    const createBody = JSON.parse((createCall.init?.body as string) ?? "{}");
    expect(createBody.variables.input.teamIds).toEqual(["t_eng"]);
  });
});

describe("linear.delete_project — delete shape", () => {
  it("returns success:true and project id after delete", async () => {
    __setFetch(
      fakeFetch({ data: { projectDelete: { success: true } } }),
    );

    const out = deleteProject.output.parse(
      await deleteProject.handler(
        { id: "proj_del" },
        { secrets: { LINEAR_API_KEY: "k" } },
      ),
    );

    expect(out.success).toBe(true);
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

// ── Cycles family ─────────────────────────────────────────────────────────

describe("linear.list_cycles — descriptor + output shape", () => {
  it("descriptor shape is correct", () => {
    expect(listCycles.id).toBe("linear.list_cycles");
    expect(listCycles.auth).toEqual(["LINEAR_API_KEY"]);
    expect(listCycles.input).toBeInstanceOf(z.ZodType);
    expect(listCycles.output).toBeInstanceOf(z.ZodType);
  });

  it("maps cycle list response to output schema", async () => {
    const CYCLES_OK = {
      data: {
        cycles: {
          nodes: [
            {
              id: "cyc_1",
              name: "Sprint 1",
              number: 1,
              startsAt: "2026-01-01T00:00:00.000Z",
              endsAt: "2026-01-14T00:00:00.000Z",
              completedAt: null,
              progress: 0,
              issueCountHistory: [],
              completedIssueCountHistory: [],
              team: { id: "t_1", name: "Engineering" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    __setFetch(fakeFetch(CYCLES_OK));

    const out = listCycles.output.parse(
      await listCycles.handler({}, { secrets: { LINEAR_API_KEY: "k" } }),
    );

    expect(out.cycles[0].id).toBe("cyc_1");
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

describe("linear.create_cycle — mutation body assertion", () => {
  it("sends team id + name + dates in mutation variables", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(
      fakeFetch(
        {
          data: {
            cycleCreate: {
              success: true,
              cycle: {
                id: "cyc_new",
                name: "Sprint 2",
                url: "https://linear.app/cycles/cyc_new",
              },
            },
          },
        },
        captured,
      ),
    );

    await createCycle.handler(
      {
        teamId: "t_eng",
        name: "Sprint 2",
        startsAt: "2026-02-01T00:00:00.000Z",
        endsAt: "2026-02-14T00:00:00.000Z",
      },
      { secrets: { LINEAR_API_KEY: "k" } },
    );

    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.variables.input.teamId).toBe("t_eng");
    expect(body.variables.input.name).toBe("Sprint 2");
  });
});

// ── Teams / Users family ──────────────────────────────────────────────────

describe("linear.list_teams — descriptor + output + auth header", () => {
  it("descriptor shape is correct", () => {
    expect(listTeams.id).toBe("linear.list_teams");
    expect(listTeams.auth).toEqual(["LINEAR_API_KEY"]);
    expect(typeof listTeams.handler).toBe("function");
  });

  it("sends Authorization header and maps team list", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const TEAMS_OK = {
      data: {
        teams: {
          nodes: [{ id: "t_1", name: "Engineering", key: "ENG", description: null }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    __setFetch(fakeFetch(TEAMS_OK, captured));

    const out = listTeams.output.parse(
      await listTeams.handler({}, { secrets: { LINEAR_API_KEY: "secret_k" } }),
    );

    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("secret_k");
    expect(out.teams[0].id).toBe("t_1");
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

describe("linear.find_user — input rejection on control chars", () => {
  it("rejects command injection in query field", () => {
    expect(findUser.input.safeParse({ query: "alice; ls -la" }).success).toBe(false);
  });
});

// ── Comments family ───────────────────────────────────────────────────────

describe("linear.list_comments — list shape", () => {
  it("descriptor shape is correct", () => {
    expect(listComments.id).toBe("linear.list_comments");
    expect(listComments.auth).toEqual(["LINEAR_API_KEY"]);
  });
});

describe("linear.create_comment — mutation body + output shape", () => {
  it("sends issueId + body in mutation variables", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(
      fakeFetch(
        {
          data: {
            commentCreate: {
              success: true,
              comment: { id: "cmt_1", body: "Good call", createdAt: "2026-01-01T00:00:00.000Z" },
            },
          },
        },
        captured,
      ),
    );

    const out = await createComment.handler(
      { issueId: "iss_1", body: "Good call" },
      { secrets: { LINEAR_API_KEY: "k" } },
    );

    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.variables.issueId).toBe("iss_1");
    expect(body.variables.body).toBe("Good call");

    const parsed = createComment.output.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.comment.id).toBe("cmt_1");
    expect(typeof parsed.estimatedTokens).toBe("number");
  });
});

// ── Labels + Workflow States family ──────────────────────────────────────

describe("linear.list_labels — descriptor + output shape", () => {
  it("descriptor shape is correct", () => {
    expect(listLabels.id).toBe("linear.list_labels");
    expect(listLabels.auth).toEqual(["LINEAR_API_KEY"]);
  });

  it("maps label list response", async () => {
    const LABELS_OK = {
      data: {
        issueLabels: {
          nodes: [
            {
              id: "lbl_1",
              name: "Bug",
              description: "Something is wrong",
              color: "#ff0000",
              isGroup: false,
              parent: null,
              team: { id: "t_1" },
            },
          ],
        },
      },
    };
    __setFetch(fakeFetch(LABELS_OK));

    const out = listLabels.output.parse(
      await listLabels.handler({}, { secrets: { LINEAR_API_KEY: "k" } }),
    );

    expect(out.labels[0].id).toBe("lbl_1");
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

describe("linear.create_label — mutation body", () => {
  it("sends teamId + name + color in mutation variables", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(
      fakeFetch(
        {
          data: {
            issueLabelCreate: {
              success: true,
              issueLabel: { id: "lbl_new", name: "Enhancement", color: "#00ff00", team: { id: "t_1" } },
            },
          },
        },
        captured,
      ),
    );

    await createLabel.handler(
      { teamId: "t_1", name: "Enhancement", color: "#00ff00" },
      { secrets: { LINEAR_API_KEY: "k" } },
    );

    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.variables.input.teamId).toBe("t_1");
    expect(body.variables.input.name).toBe("Enhancement");
    expect(body.variables.input.color).toBe("#00ff00");
  });
});

describe("linear.delete_label — delete shape", () => {
  it("returns success:true after deletion", async () => {
    __setFetch(
      fakeFetch({ data: { issueLabelDelete: { success: true } } }),
    );

    const out = deleteLabel.output.parse(
      await deleteLabel.handler(
        { id: "lbl_del" },
        { secrets: { LINEAR_API_KEY: "k" } },
      ),
    );

    expect(out.success).toBe(true);
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

describe("linear.list_workflow_states — descriptor + output shape", () => {
  it("descriptor shape is correct", () => {
    expect(listWorkflowStates.id).toBe("linear.list_workflow_states");
    expect(listWorkflowStates.auth).toEqual(["LINEAR_API_KEY"]);
  });

  it("maps workflow states list response", async () => {
    const STATES_OK = {
      data: {
        workflowStates: {
          nodes: [
            {
              id: "ws_1",
              name: "In Progress",
              type: "started",
              color: "#ff9900",
              position: 1,
              description: null,
              team: { id: "t_1", name: "Engineering" },
            },
          ],
        },
      },
    };
    __setFetch(fakeFetch(STATES_OK));

    const out = listWorkflowStates.output.parse(
      await listWorkflowStates.handler({}, { secrets: { LINEAR_API_KEY: "k" } }),
    );

    expect(out.workflowStates[0].id).toBe("ws_1");
    expect(out.workflowStates[0].type).toBe("started");
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

describe("linear.create_workflow_state — input rejection", () => {
  it("rejects command injection in teamId field", () => {
    expect(
      createWorkflowState.input.safeParse({
        teamId: "t_1; rm -rf /",
        name: "New State",
        type: "started",
        color: "#000000",
      }).success,
    ).toBe(false);
  });
});

// ── Attachments family ────────────────────────────────────────────────────

describe("linear.list_attachments — descriptor shape", () => {
  it("descriptor shape is correct", () => {
    expect(listAttachments.id).toBe("linear.list_attachments");
    expect(listAttachments.auth).toEqual(["LINEAR_API_KEY"]);
    expect(listAttachments.input).toBeInstanceOf(z.ZodType);
    expect(listAttachments.output).toBeInstanceOf(z.ZodType);
  });
});

describe("linear.delete_attachment — delete shape", () => {
  it("returns success:true with attachmentId", async () => {
    __setFetch(
      fakeFetch({ data: { attachmentDelete: { success: true } } }),
    );

    const out = deleteAttachment.output.parse(
      await deleteAttachment.handler(
        { attachmentId: "att_del" },
        { secrets: { LINEAR_API_KEY: "k" } },
      ),
    );

    expect(out.success).toBe(true);
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

// ── Reactions family ─────────────────────────────────────────────────────

describe("linear.create_reaction — mutation body", () => {
  it("sends commentId + emoji in mutation variables", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(
      fakeFetch(
        {
          data: {
            reactionCreate: {
              success: true,
              reaction: {
                id: "rxn_1",
                emoji: "👍",
                user: { id: "u_1", name: "Alice" },
                comment: { id: "cmt_1" },
              },
            },
          },
        },
        captured,
      ),
    );

    await createReaction.handler(
      { commentId: "cmt_1", emoji: "👍" },
      { secrets: { LINEAR_API_KEY: "k" } },
    );

    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.variables.input.commentId).toBe("cmt_1");
    expect(body.variables.input.emoji).toBe("👍");
  });
});

describe("linear.delete_reaction — delete shape", () => {
  it("returns success:true", async () => {
    __setFetch(fakeFetch({ data: { reactionDelete: { success: true } } }));

    const out = deleteReaction.output.parse(
      await deleteReaction.handler(
        { id: "rxn_del" },
        { secrets: { LINEAR_API_KEY: "k" } },
      ),
    );

    expect(out.success).toBe(true);
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

// ── Initiatives family ────────────────────────────────────────────────────

describe("linear.create_initiative — mutation body + output", () => {
  it("sends name in mutation variables and returns initiative id", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(
      fakeFetch(
        {
          data: {
            initiativeCreate: {
              success: true,
              initiative: {
                id: "init_1",
                name: "Reliability Initiative",
                description: null,
                url: "https://linear.app/initiatives/init_1",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          },
        },
        captured,
      ),
    );

    const out = await createInitiative.handler(
      { name: "Reliability Initiative" },
      { secrets: { LINEAR_API_KEY: "k" } },
    );

    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.variables.input.name).toBe("Reliability Initiative");

    const parsed = createInitiative.output.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.initiative.id).toBe("init_1");
    expect(typeof parsed.estimatedTokens).toBe("number");
  });
});

describe("linear.list_initiatives — descriptor shape", () => {
  it("descriptor shape is correct", () => {
    expect(listInitiatives.id).toBe("linear.list_initiatives");
    expect(listInitiatives.auth).toEqual(["LINEAR_API_KEY"]);
    expect(listInitiatives.input).toBeInstanceOf(z.ZodType);
    expect(listInitiatives.output).toBeInstanceOf(z.ZodType);
  });
});

describe("linear.delete_initiative — delete shape", () => {
  it("returns success:true", async () => {
    __setFetch(fakeFetch({ data: { initiativeDelete: { success: true } } }));

    const out = deleteInitiative.output.parse(
      await deleteInitiative.handler(
        { id: "init_del" },
        { secrets: { LINEAR_API_KEY: "k" } },
      ),
    );

    expect(out.success).toBe(true);
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

// ── Documents family (camelCase ids — plan §4) ────────────────────────────

describe("linear.documents (list) — output mapping + truncation", () => {
  it("maps document list and truncates content to 200 chars", async () => {
    const DOCS_OK = {
      data: {
        documents: {
          nodes: [
            {
              id: "doc_1",
              title: "Architecture Decision",
              content: "b".repeat(400), // > 200 to prove truncation
              slugId: "arch-decision",
              url: "https://linear.app/docs/doc_1",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
    };
    __setFetch(fakeFetch(DOCS_OK));

    const out = listDocuments.output.parse(
      await listDocuments.handler({}, { secrets: { LINEAR_API_KEY: "k" } }),
    );

    expect(out.documents[0].id).toBe("doc_1");
    expect(out.documents[0].content?.length).toBe(200);
    expect(out.totalDocuments).toBe(1);
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

describe("linear.createDocument — mutation body + output", () => {
  it("sends title + content in mutation variables and returns document id", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(
      fakeFetch(
        {
          data: {
            documentCreate: {
              success: true,
              document: {
                id: "doc_new",
                title: "New Doc",
                slugId: "new-doc",
                url: "https://linear.app/docs/new-doc",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          },
        },
        captured,
      ),
    );

    const out = await createDocument.handler(
      { title: "New Doc", content: "# Architecture\n\nDetails here." },
      { secrets: { LINEAR_API_KEY: "k" } },
    );

    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.variables.title).toBe("New Doc");
    expect(body.variables.content).toBe("# Architecture\n\nDetails here.");

    const parsed = createDocument.output.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.document.id).toBe("doc_new");
    expect(typeof parsed.estimatedTokens).toBe("number");
  });
});

describe("linear.updateDocument — mutation body + output", () => {
  it("sends id + title + content in mutation variables", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(
      fakeFetch(
        {
          data: {
            documentUpdate: {
              success: true,
              document: {
                id: "doc_upd",
                title: "Updated Doc",
                slugId: "updated-doc",
                url: "https://linear.app/docs/updated-doc",
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            },
          },
        },
        captured,
      ),
    );

    const out = await updateDocument.handler(
      { id: "doc_upd", title: "Updated Doc" },
      { secrets: { LINEAR_API_KEY: "k" } },
    );

    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.variables.id).toBe("doc_upd");
    expect(body.variables.title).toBe("Updated Doc");

    const parsed = updateDocument.output.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.document.id).toBe("doc_upd");
    expect(typeof parsed.estimatedTokens).toBe("number");
  });
});

// ── Issue Relations family ────────────────────────────────────────────────

describe("linear.list_issue_relations — descriptor shape", () => {
  it("descriptor shape is correct", () => {
    expect(listIssueRelations.id).toBe("linear.list_issue_relations");
    expect(listIssueRelations.auth).toEqual(["LINEAR_API_KEY"]);
    expect(listIssueRelations.input).toBeInstanceOf(z.ZodType);
    expect(listIssueRelations.output).toBeInstanceOf(z.ZodType);
  });
});

describe("linear.create_issue_relation — mutation body", () => {
  it("sends issueId + relatedIssueId + type in mutation variables", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(
      fakeFetch(
        {
          data: {
            issueRelationCreate: {
              success: true,
              issueRelation: {
                id: "rel_1",
                type: "blocks",
                issue: { id: "iss_1" },
                relatedIssue: { id: "iss_2" },
              },
            },
          },
        },
        captured,
      ),
    );

    await createIssueRelation.handler(
      { issueId: "iss_1", relatedIssueId: "iss_2", type: "blocks" },
      { secrets: { LINEAR_API_KEY: "k" } },
    );

    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.variables.input.issueId).toBe("iss_1");
    expect(body.variables.input.relatedIssueId).toBe("iss_2");
    expect(body.variables.input.type).toBe("blocks");
  });
});

describe("linear.delete_issue_relation — delete shape", () => {
  it("returns success:true for a valid delete", async () => {
    __setFetch(
      fakeFetch({ data: { issueRelationDelete: { success: true } } }),
    );

    const out = deleteIssueRelation.output.parse(
      await deleteIssueRelation.handler(
        { relationId: "rel_del" },
        { secrets: { LINEAR_API_KEY: "k" } },
      ),
    );

    expect(out.success).toBe(true);
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

// ── GraphQL error + HTTP error sanitization (cross-family) ────────────────

describe("linearGraphQL error handling (via list_projects representative)", () => {
  it("throws with the upstream GraphQL error message", async () => {
    __setFetch(
      fakeFetch({ errors: [{ message: "Not authorized to view projects" }] }),
    );

    await expect(
      listProjects.handler({}, { secrets: { LINEAR_API_KEY: "bad_k" } }),
    ).rejects.toThrow(/Not authorized to view projects/);
  });

  it("throws 'Linear API HTTP 500' on HTTP error status", async () => {
    __setFetch(fakeHttpError(500));

    await expect(
      listProjects.handler({}, { secrets: { LINEAR_API_KEY: "k" } }),
    ).rejects.toThrow("Linear API HTTP 500");
  });
});
