/**
 * `linear.list_issues` — first real catalog tool (A0-CATALOG spike).
 *
 * Ported from the marketplace wrapper `core/tools/linear/list-issues.ts` into a
 * gateway {@link ToolDescriptor}, applying the §6.2 adapter rules:
 *
 *  1. `name: 'linear.list_issues'` → `id` + a display `name`.
 *  2. `parameters` → `input`; the internal output Zod is lifted to `output`.
 *  3. The `init.js` side-effect + `createLinearClient()` + `testToken` param are
 *     replaced by `auth: ["LINEAR_API_KEY"]`; the handler builds the Linear
 *     GraphQL request from `ctx.secrets.LINEAR_API_KEY` (CTX-only contract,
 *     descriptor.ts:38-43) — it never reads an env var or constructs a client
 *     outside `ctx`.
 *  4. The `@praetorian/claude-tool-sdk` validators are inlined here (a few pure
 *     functions) so this wrapper is a SELF-CONTAINED portable unit: it imports
 *     ONLY `zod` from node_modules and no gateway source, so bare Node can serve
 *     the compiled `wrapper.js` (SF-1, wrapper-resolve.ts:27-33). A canonical
 *     copy of these helpers also lives in `gateway/src/sanitize.ts` for in-tree
 *     code (O8).
 *  5. No `${CLAUDE_PLUGIN_ROOT}`, no `.claude` paths, no OAuth machinery — a raw
 *     `fetch` to Linear's GraphQL endpoint with the API key in the
 *     `Authorization` header keeps this dependency-free (no `@linear/sdk`).
 *
 * `ToolDescriptor` is imported as a TYPE only (erased at compile) so the runtime
 * `.js` has no gateway-source dependency.
 */
import { z } from "zod";
// ── Inlined sanitizers (keep this wrapper a self-contained portable unit) ─────
const PATH_TRAVERSAL = [/\.\.\//, /\.\.\\/, /\.\.$/, /^\.\.$/, /~\//];
const COMMAND_INJECTION = [/[;&|`$]/, /\$\(/, /`[^`]*`/, /\|\|/, /&&/, />\s*\/|>>/, /<\s*\//];
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]");
const noPathTraversal = (s) => !PATH_TRAVERSAL.some((p) => p.test(s));
const noCommandInjection = (s) => !COMMAND_INJECTION.some((p) => p.test(s));
const noControlChars = (s) => !CONTROL_CHARS.test(s);
/** ~4 chars per token over the JSON encoding (mirrors the marketplace estimate). */
function estimateTokens(data) {
    const json = typeof data === "string" ? data : JSON.stringify(data);
    return Math.ceil(json.length / 4);
}
/** A safe-string filter field: rejects control chars, path traversal, injection. */
function safeFilter(describe) {
    return z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe(describe);
}
let activeFetch = (url, init) => globalThis.fetch(url, init);
/** TEST-ONLY: override the transport so no real HTTP happens in unit tests. */
export function __setFetch(fn) {
    activeFetch = fn;
}
/** TEST-ONLY: restore the default global `fetch`. */
export function __resetFetch() {
    activeFetch = (url, init) => globalThis.fetch(url, init);
}
// ── Schemas (rule 2: `parameters` → `input`; internal output lifted to `output`)
// NOTE: no `.default()` on input fields. The gateway's `ToolDescriptor` types
// `input` as `z.ZodType<I>`, which requires the schema's input and output types
// to coincide; `.default()` makes them diverge and breaks the assignment.
// Defaults are applied inside the handler instead (DEFAULT_LIMIT / orderBy).
const input = z.object({
    assignee: safeFilter('User ID, name, email, or "me"'),
    creator: safeFilter("Creator user ID or name"),
    team: safeFilter("Team name or ID"),
    state: safeFilter("State name or ID"),
    project: safeFilter("Project name or ID"),
    label: safeFilter("Label name or ID"),
    parent: safeFilter("Parent issue ID or identifier to filter children/sub-issues"),
    query: safeFilter("Search for content in title or description"),
    limit: z.number().min(1).max(250).optional().describe("Number of results (max 250, default 50)"),
    includeArchived: z.boolean().optional(),
    orderBy: z.enum(["createdAt", "updatedAt"]).optional(),
});
const DEFAULT_LIMIT = 50;
const output = z.object({
    issues: z.array(z.object({
        id: z.string(),
        identifier: z.string().optional(),
        title: z.string(),
        description: z.string().optional(),
        priority: z.number().nullable().optional(),
        priorityLabel: z.string().nullable().optional(),
        state: z
            .object({ id: z.string(), name: z.string(), type: z.string() })
            .optional(),
        status: z.string().optional(),
        assignee: z.string().optional(),
        assigneeId: z.string().optional(),
        creator: z.string().optional(),
        creatorId: z.string().optional(),
        url: z.string().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        cycle: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
        parent: z.object({ id: z.string(), identifier: z.string() }).nullable().optional(),
        dueDate: z.string().nullable().optional(),
    })),
    totalIssues: z.number(),
    nextOffset: z.string().optional(),
    estimatedTokens: z.number(),
});
// ── GraphQL (carried verbatim from the marketplace wrapper) ───────────────────
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const LIST_ISSUES_QUERY = `
  query IssuesList($first: Int, $filter: IssueFilter, $orderBy: PaginationOrderBy) {
    issues(first: $first, filter: $filter, orderBy: $orderBy) {
      nodes {
        id identifier title description priority priorityLabel
        state { id name type }
        assignee { id name }
        creator { id name }
        url createdAt updatedAt
        cycle { id name }
        parent { id identifier }
        dueDate
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
/**
 * Build a Linear `IssueFilter` from the validated input. Only string filters the
 * tool supports are mapped; UUID-vs-name disambiguation from the marketplace
 * wrapper is intentionally NOT ported (the spike's scope is the adapter, not
 * filter fidelity) — name filters are used, matching Linear's `IssueFilter`.
 */
function buildFilter(args) {
    const filter = {};
    if (args.team)
        filter.team = { name: { eq: args.team } };
    if (args.assignee)
        filter.assignee = { name: { eq: args.assignee } };
    if (args.creator)
        filter.creator = { name: { eq: args.creator } };
    if (args.state)
        filter.state = { name: { eq: args.state } };
    if (args.project)
        filter.project = { name: { eq: args.project } };
    if (args.label)
        filter.labels = { name: { eq: args.label } };
    if (args.parent)
        filter.parent = { id: { eq: args.parent } };
    if (args.query)
        filter.searchableContent = { contains: args.query };
    return filter;
}
/**
 * List issues from Linear via a raw GraphQL POST.
 *
 * CTX-ONLY: the API key is taken from `ctx.secrets.LINEAR_API_KEY` and sent in
 * the `Authorization` header — the handler never reads `process.env` or builds a
 * client outside `ctx`. The transport is `activeFetch` (the global `fetch` in
 * production; an injected fake in tests).
 */
export const listIssues = {
    id: "linear.list_issues",
    name: "List Linear Issues",
    description: "List issues from Linear with optional filters (team, assignee, state, query, …).",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input,
    output,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const res = await activeFetch(LINEAR_GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                // Linear personal API keys go in Authorization with NO "Bearer " prefix.
                Authorization: apiKey,
            },
            body: JSON.stringify({
                query: LIST_ISSUES_QUERY,
                variables: {
                    first: args.limit ?? DEFAULT_LIMIT,
                    filter: buildFilter(args),
                    orderBy: args.orderBy ?? "updatedAt",
                },
            }),
        });
        if (!res.ok) {
            throw new Error(`Linear API HTTP ${res.status}`);
        }
        const envelope = (await res.json());
        if (envelope.errors && envelope.errors.length > 0) {
            throw new Error(`Linear GraphQL error: ${envelope.errors.map((e) => e.message).join("; ")}`);
        }
        const nodes = envelope.data?.issues?.nodes ?? [];
        const issues = nodes.map((n) => ({
            id: n.id,
            identifier: n.identifier ?? undefined,
            title: n.title,
            description: n.description?.substring(0, 200) || undefined,
            priority: n.priority ?? undefined,
            priorityLabel: n.priorityLabel ?? undefined,
            state: n.state ? { id: n.state.id, name: n.state.name, type: n.state.type } : undefined,
            status: n.state?.name || undefined,
            assignee: n.assignee?.name || undefined,
            assigneeId: n.assignee?.id || undefined,
            creator: n.creator?.name || undefined,
            creatorId: n.creator?.id || undefined,
            url: n.url || undefined,
            createdAt: n.createdAt || undefined,
            updatedAt: n.updatedAt || undefined,
            cycle: n.cycle || undefined,
            parent: n.parent ? { id: n.parent.id, identifier: n.parent.identifier } : undefined,
            dueDate: n.dueDate ?? undefined,
        }));
        const base = {
            issues,
            totalIssues: issues.length,
            nextOffset: envelope.data?.issues?.pageInfo.hasNextPage
                ? envelope.data.issues.pageInfo.endCursor || undefined
                : undefined,
        };
        return { ...base, estimatedTokens: estimateTokens(base) };
    },
};
/**
 * Execute a Linear GraphQL request via the injectable `activeFetch` transport.
 * CTX-only: the caller passes `apiKey` (from `ctx.secrets.LINEAR_API_KEY`); it is sent in the
 * `Authorization` header with NO "Bearer " prefix. Throws on HTTP !ok, on a non-empty
 * `errors[]`, and on null/undefined `data` — mirroring marketplace `parseGraphQLResponse`.
 */
async function linearGraphQL(apiKey, query, variables = {}) {
    const res = await activeFetch(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
        throw new Error(`Linear API HTTP ${res.status}`);
    }
    const env = (await res.json());
    if (env.errors && env.errors.length > 0) {
        throw new Error(`Linear GraphQL error: ${env.errors.map((e) => e.message).join("; ")}`);
    }
    if (env.data === null || env.data === undefined) {
        throw new Error("No data returned from GraphQL query");
    }
    return env.data;
}
// ── 1.5 Free-text validator (whitespace-allowing) + safeText factory ──────────
/** Allow \t \n \r (whitespace) but reject other control chars. */
const CONTROL_CHARS_NO_WS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]");
const noControlCharsAllowWhitespace = (s) => !CONTROL_CHARS_NO_WS.test(s);
/**
 * A free-text field (title/description/body): allows whitespace, rejects other control chars,
 * path traversal, and command injection. Use for human-prose fields, NOT for IDs/filters.
 */
function safeText(describe) {
    return z
        .string()
        .refine(noControlCharsAllowWhitespace, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe(describe);
}
// ── 1.2 isUUID + ID resolvers (inlined from lib/resolve-ids.ts; apiKey-taking) ─
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(s) {
    return UUID_REGEX.test(s);
}
const WORKFLOW_STATES_QUERY = `
  query WorkflowStates($teamId: ID!) {
    workflowStates(filter: { team: { id: { eq: $teamId } } }) {
      nodes {
        id
        name
        type
      }
    }
  }
`;
const VIEWER_QUERY = `
  query Viewer {
    viewer {
      id
    }
  }
`;
const PROJECTS_FOR_RESOLUTION_QUERY = `
  query ProjectsForResolution {
    projects(first: 250, includeArchived: false) {
      nodes {
        id
        name
      }
    }
  }
`;
const TEAMS_QUERY = `
  query TeamsForResolution {
    teams(first: 250) {
      nodes {
        id
        name
        key
      }
    }
  }
`;
const ISSUE_RESOLVE_QUERY = `
  query IssueResolve($id: String!) {
    issue(id: $id) {
      id
    }
  }
`;
/** Resolve team name to team UUID (UUID pass-through; else match by name, case-insensitive). */
async function resolveTeamId(apiKey, teamNameOrId) {
    if (isUUID(teamNameOrId)) {
        return teamNameOrId;
    }
    const response = await linearGraphQL(apiKey, TEAMS_QUERY, {});
    const teams = response.teams?.nodes || [];
    const team = teams.find((t) => t.name.toLowerCase() === teamNameOrId.toLowerCase());
    if (!team) {
        const availableTeams = teams.map((t) => t.name).join(", ");
        throw new Error(`Team not found: ${teamNameOrId}\n\n` +
            `Available teams: ${availableTeams || "(none)"}\n\n` +
            `Tip: Team names are case-insensitive but must match exactly.`);
    }
    return team.id;
}
/** Resolve state name/type to state UUID (UUID pass-through; else match name or type). */
async function resolveStateId(apiKey, teamId, stateNameOrId) {
    if (isUUID(stateNameOrId)) {
        return stateNameOrId;
    }
    const response = await linearGraphQL(apiKey, WORKFLOW_STATES_QUERY, {
        teamId,
    });
    const state = response.workflowStates.nodes.find((s) => s.name.toLowerCase() === stateNameOrId.toLowerCase() ||
        s.type.toLowerCase() === stateNameOrId.toLowerCase());
    if (!state) {
        throw new Error(`State not found: ${stateNameOrId}`);
    }
    return state.id;
}
/** Resolve assignee ("me"/email/name) to user UUID (UUID pass-through). */
async function resolveAssigneeId(apiKey, assigneeNameOrId) {
    if (assigneeNameOrId.toLowerCase() === "me") {
        const viewer = await linearGraphQL(apiKey, VIEWER_QUERY, {});
        return viewer.viewer.id;
    }
    if (isUUID(assigneeNameOrId)) {
        return assigneeNameOrId;
    }
    const FIND_USER_QUERY = `
    query Users($filter: UserFilter) {
      users(filter: $filter, first: 1) {
        nodes {
          id
          name
          email
          displayName
          avatarUrl
          active
          admin
          createdAt
        }
      }
    }
  `;
    const response = await linearGraphQL(apiKey, FIND_USER_QUERY, {
        filter: {
            or: [
                { email: { containsIgnoreCase: assigneeNameOrId } },
                { name: { containsIgnoreCase: assigneeNameOrId } },
                { displayName: { containsIgnoreCase: assigneeNameOrId } },
            ],
        },
    });
    const users = response.users?.nodes || [];
    if (users.length === 0) {
        throw new Error(`User not found: ${assigneeNameOrId}`);
    }
    return users[0].id;
}
/** Resolve parent issue identifier (e.g. "RT-252") to issue UUID (UUID pass-through). */
async function resolveParentId(apiKey, parentIdentifierOrId) {
    if (isUUID(parentIdentifierOrId)) {
        return parentIdentifierOrId;
    }
    const response = await linearGraphQL(apiKey, ISSUE_RESOLVE_QUERY, {
        id: parentIdentifierOrId,
    });
    if (!response.issue?.id) {
        throw new Error(`Parent issue not found: ${parentIdentifierOrId}`);
    }
    return response.issue.id;
}
/** Resolve project name to project UUID (UUID pass-through; else match name, case-insensitive). */
async function resolveProjectId(apiKey, projectNameOrId) {
    if (isUUID(projectNameOrId)) {
        return projectNameOrId;
    }
    const response = await linearGraphQL(apiKey, PROJECTS_FOR_RESOLUTION_QUERY, {});
    const project = response.projects.nodes.find((p) => p.name.toLowerCase() === projectNameOrId.toLowerCase());
    if (!project) {
        throw new Error(`Project not found: ${projectNameOrId}`);
    }
    return project.id;
}
// ── 1.3 resolveTemplateForProject (inlined from lib/resolve-template.ts) ──────
const TEMPLATES_WITH_DATA_QUERY = `
  query Templates {
    templates {
      id
      name
      type
      templateData
    }
  }
`;
/** Parse templateData field which can be a JSON string or an object. */
function parseTemplateData(raw) {
    if (!raw)
        return null;
    if (typeof raw === "string") {
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    if (typeof raw === "object") {
        return raw;
    }
    return null;
}
/** Find the issue template associated with a project (returns template id or undefined). */
async function resolveTemplateForProject(apiKey, projectId) {
    const response = await linearGraphQL(apiKey, TEMPLATES_WITH_DATA_QUERY, {});
    const templates = response.templates || [];
    for (const template of templates) {
        if (template.type !== "issue")
            continue;
        const data = parseTemplateData(template.templateData);
        if (data?.projectId === projectId) {
            return template.id;
        }
    }
    return undefined;
}
// ════════════════════════════════════════════════════════════════════════════
// linear.get_issue
// ════════════════════════════════════════════════════════════════════════════
const GET_ISSUE_QUERY = `
  query Issue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      priority
      priorityLabel
      estimate
      state {
        id
        name
        type
      }
      assignee {
        id
        name
        email
      }
      project {
        id
        name
      }
      cycle {
        id
        name
      }
      parent {
        id
        identifier
      }
      dueDate
      url
      branchName
      createdAt
      updatedAt
      attachments {
        nodes {
          id
          title
          url
        }
      }
    }
  }
`;
const getIssueInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Issue ID or identifier (e.g., ENG-1366 or UUID)"),
    fullDescription: z
        .boolean()
        .optional()
        .describe("Return full description without truncation (default: false, truncates to 500 chars)"),
});
const getIssueOutput = z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    description: z.string().optional(),
    priority: z.number().nullable().optional(),
    priorityLabel: z.string().optional(),
    estimate: z.number().nullable().optional(),
    state: z.object({ id: z.string(), name: z.string(), type: z.string() }).optional(),
    assignee: z
        .object({ id: z.string(), name: z.string(), email: z.string() })
        .nullable()
        .optional(),
    project: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
    cycle: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
    parent: z.object({ id: z.string(), identifier: z.string() }).nullable().optional(),
    dueDate: z.string().nullable().optional(),
    url: z.string().optional(),
    branchName: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    attachments: z
        .array(z.object({ id: z.string(), title: z.string(), url: z.string() }))
        .optional(),
    estimatedTokens: z.number(),
});
export const getIssue = {
    id: "linear.get_issue",
    name: "Get Linear Issue",
    description: "Get detailed information about a specific Linear issue",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: getIssueInput,
    output: getIssueOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const fullDescription = args.fullDescription ?? false;
        const response = await linearGraphQL(apiKey, GET_ISSUE_QUERY, { id: args.id });
        if (!response.issue) {
            throw new Error(`Issue not found: ${args.id}`);
        }
        const issue = response.issue;
        const baseData = {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: fullDescription ? issue.description : issue.description?.substring(0, 500),
            priority: issue.priority ?? undefined,
            priorityLabel: issue.priorityLabel || undefined,
            estimate: issue.estimate ?? undefined,
            state: issue.state && issue.state.id
                ? { id: issue.state.id, name: issue.state.name, type: issue.state.type }
                : undefined,
            assignee: issue.assignee || undefined,
            project: issue.project || undefined,
            cycle: issue.cycle || undefined,
            parent: issue.parent || undefined,
            dueDate: issue.dueDate ?? undefined,
            url: issue.url,
            branchName: issue.branchName,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
            attachments: issue.attachments?.nodes?.map((a) => ({
                id: a.id,
                title: a.title,
                url: a.url,
            })),
        };
        return getIssueOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.update_issue  (ported before create_issue so create_issue's cycle
// orchestration can call updateIssue.handler directly — no dynamic import)
// ════════════════════════════════════════════════════════════════════════════
const GET_ISSUE_TEAM_QUERY = `
  query IssueTeam($id: String!) {
    issue(id: $id) {
      team {
        id
      }
    }
  }
`;
const UPDATE_ISSUE_MUTATION = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id
        identifier
        title
        url
        project {
          id
          name
        }
      }
    }
  }
`;
const updateIssueInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Issue ID or identifier"),
    title: safeText("New title").optional(),
    description: z
        .string()
        .refine(noControlCharsAllowWhitespace, "Dangerous control characters not allowed")
        .optional()
        .describe("New description (Markdown)"),
    assignee: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe('User ID, name, email, or "me"'),
    state: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("State type, name, or ID"),
    priority: z.number().min(0).max(4).optional().describe("0=No priority, 1=Urgent, 2=High, 3=Normal, 4=Low"),
    project: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .nullable()
        .optional()
        .describe("Project name or ID (set to null to remove issue from project)"),
    labels: z
        .array(z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noCommandInjection, "Invalid characters detected"))
        .optional()
        .describe("Label names or IDs"),
    dueDate: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Due date (ISO format)"),
    parent: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Parent issue identifier (e.g., RT-252) or ID - resolves to parentId"),
    parentId: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Parent issue ID for sub-issues"),
    cycle: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Cycle (sprint) ID to assign issue to"),
});
const updateIssueOutput = z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    url: z.string(),
    project: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
    estimatedTokens: z.number(),
});
export const updateIssue = {
    id: "linear.update_issue",
    name: "Update Linear Issue",
    description: "Update an existing issue in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: updateIssueInput,
    output: updateIssueOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const { id, ...updateFields } = args;
        // Fetch issue team if state resolution is needed (teamId BEFORE resolveStateId).
        let teamId;
        if (updateFields.state) {
            const teamResponse = await linearGraphQL(apiKey, GET_ISSUE_TEAM_QUERY, {
                id,
            });
            teamId = teamResponse.issue.team.id;
        }
        const mutationInput = {};
        if (updateFields.title) {
            mutationInput.title = updateFields.title;
        }
        if (updateFields.description) {
            mutationInput.description = updateFields.description;
        }
        if (updateFields.assignee) {
            mutationInput.assigneeId = await resolveAssigneeId(apiKey, updateFields.assignee);
        }
        if (updateFields.state && teamId) {
            mutationInput.stateId = await resolveStateId(apiKey, teamId, updateFields.state);
        }
        if (updateFields.priority !== undefined) {
            mutationInput.priority = updateFields.priority;
        }
        if (updateFields.project !== undefined) {
            if (updateFields.project === null) {
                mutationInput.projectId = null;
            }
            else {
                mutationInput.projectId = await resolveProjectId(apiKey, updateFields.project);
            }
        }
        if (updateFields.labels) {
            mutationInput.labelIds = updateFields.labels;
        }
        if (updateFields.dueDate) {
            mutationInput.dueDate = updateFields.dueDate;
        }
        if (updateFields.parent) {
            mutationInput.parentId = await resolveParentId(apiKey, updateFields.parent);
        }
        else if (updateFields.parentId) {
            mutationInput.parentId = updateFields.parentId;
        }
        if (updateFields.cycle) {
            mutationInput.cycleId = updateFields.cycle;
        }
        const response = await linearGraphQL(apiKey, UPDATE_ISSUE_MUTATION, {
            id,
            input: mutationInput,
        });
        if (!response.issueUpdate?.success || !response.issueUpdate?.issue) {
            throw new Error("Failed to update issue");
        }
        const baseData = {
            id: response.issueUpdate.issue.id,
            identifier: response.issueUpdate.issue.identifier,
            title: response.issueUpdate.issue.title,
            url: response.issueUpdate.issue.url,
            project: response.issueUpdate.issue.project || undefined,
        };
        return updateIssueOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.create_issue
// ════════════════════════════════════════════════════════════════════════════
const CREATE_ISSUE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        title
        url
      }
    }
  }
`;
const createIssueInput = z.object({
    title: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .describe("Issue title"),
    description: z
        .string()
        .refine(noControlCharsAllowWhitespace, "Dangerous control characters not allowed")
        .optional()
        .describe("Issue description (Markdown)"),
    team: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Team name or ID"),
    assignee: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe('User ID, name, email, or "me"'),
    state: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("State type, name, or ID"),
    priority: z.number().min(0).max(4).optional().describe("0=No priority, 1=Urgent, 2=High, 3=Normal, 4=Low"),
    project: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Project name or ID"),
    labels: z
        .array(z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noCommandInjection, "Invalid characters detected"))
        .optional()
        .describe("Label names or IDs"),
    dueDate: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Due date (ISO format)"),
    parent: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Parent issue identifier (e.g., RT-252) or ID - resolves to parentId"),
    parentId: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Parent issue ID for sub-issues"),
    cycle: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Cycle (sprint) ID or name - will be set via update after creation"),
    templateId: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Issue template ID to apply"),
    autoApplyProjectTemplate: z
        .boolean()
        .optional()
        .describe("Automatically find and apply template for the specified project"),
});
const createIssueOutput = z.object({
    success: z.boolean(),
    issue: z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        url: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const createIssue = {
    id: "linear.create_issue",
    name: "Create Linear Issue",
    description: "Create a new issue in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createIssueInput,
    output: createIssueOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const { cycle, templateId, autoApplyProjectTemplate, parent, ...createParams } = args;
        // Resolve template ID if auto-apply is requested (SILENT fallback on failure).
        let resolvedTemplateId = templateId;
        if (autoApplyProjectTemplate && createParams.project && !resolvedTemplateId) {
            try {
                const projectId = await resolveProjectId(apiKey, createParams.project);
                resolvedTemplateId = await resolveTemplateForProject(apiKey, projectId);
                // Silent fallback: if no template found, proceed without one.
            }
            catch (error) {
                // Template lookup failed, proceed without template (do not abort the create).
                console.warn(`Template lookup failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // Resolve team name to UUID before building mutation input.
        const teamId = await resolveTeamId(apiKey, createParams.team);
        const mutationInput = {
            title: createParams.title,
            teamId,
        };
        if (createParams.description) {
            mutationInput.description = createParams.description;
        }
        if (createParams.assignee) {
            mutationInput.assigneeId = await resolveAssigneeId(apiKey, createParams.assignee);
        }
        if (createParams.state) {
            mutationInput.stateId = await resolveStateId(apiKey, teamId, createParams.state);
        }
        if (createParams.priority !== undefined) {
            mutationInput.priority = createParams.priority;
        }
        if (createParams.project) {
            mutationInput.projectId = await resolveProjectId(apiKey, createParams.project);
        }
        if (createParams.labels) {
            mutationInput.labelIds = createParams.labels;
        }
        if (createParams.dueDate) {
            mutationInput.dueDate = createParams.dueDate;
        }
        if (parent) {
            mutationInput.parentId = await resolveParentId(apiKey, parent);
        }
        else if (createParams.parentId) {
            mutationInput.parentId = createParams.parentId;
        }
        if (resolvedTemplateId) {
            mutationInput.templateId = resolvedTemplateId;
        }
        const response = await linearGraphQL(apiKey, CREATE_ISSUE_MUTATION, {
            input: mutationInput,
        });
        if (!response.issueCreate?.success) {
            throw new Error("Failed to create issue. Check that:\n" +
                "- Team exists and you have access\n" +
                "- All required fields are provided (title, team)\n" +
                "- Optional fields (assignee, state, project) reference valid entities");
        }
        if (!response.issueCreate?.issue) {
            throw new Error("Failed to create issue: No issue returned from API");
        }
        // If cycle was provided, update the issue to assign it (Linear can't set cycle on create).
        // Internal call to updateIssue.handler with the SAME ctx — NOT a dynamic import.
        if (cycle) {
            try {
                await updateIssue.handler({ id: response.issueCreate.issue.identifier, cycle }, ctx);
            }
            catch (error) {
                // Issue created successfully but cycle assignment failed: warn, don't fail the operation.
                console.warn(`Warning: Issue created but cycle assignment failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const baseData = {
            success: response.issueCreate.success,
            issue: {
                id: response.issueCreate.issue.id,
                identifier: response.issueCreate.issue.identifier,
                title: response.issueCreate.issue.title,
                url: response.issueCreate.issue.url,
            },
        };
        return createIssueOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.find_issue  (own multi-step probing; calls getIssue.handler internally)
// ════════════════════════════════════════════════════════════════════════════
const SEARCH_ISSUES_QUERY = `
  query Issues($first: Int!, $filter: IssueFilter, $orderBy: PaginationOrderBy) {
    issues(first: $first, filter: $filter, orderBy: $orderBy) {
      nodes {
        id
        identifier
        title
        state {
          id
          name
          type
        }
        assignee {
          name
        }
        url
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
const findIssueInput = z.object({
    query: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Issue ID, identifier, number, or search text"),
    team: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Team name to narrow search (optional)"),
    maxResults: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe("Max matches to return for disambiguation"),
});
const issueCandidateSchema = z.object({
    identifier: z.string(),
    title: z.string(),
    state: z.string().optional(),
    assignee: z.string().optional(),
    url: z.string().optional(),
});
const findIssueOutput = z.discriminatedUnion("status", [
    z.object({ status: z.literal("found"), issue: getIssueOutput }),
    z.object({
        status: z.literal("disambiguation_needed"),
        message: z.string(),
        query: z.string(),
        candidates: z.array(issueCandidateSchema),
        hint: z.string(),
    }),
    z.object({
        status: z.literal("not_found"),
        message: z.string(),
        query: z.string(),
        suggestions: z.array(z.string()),
    }),
]);
const FIND_ISSUE_DEFAULT_MAX_RESULTS = 5;
/** Check if input looks like an issue identifier (ABC-123, number-only, or UUID). */
function looksLikeIdentifier(input) {
    if (/^[A-Z]+-\d+$/i.test(input))
        return true;
    if (/^\d+$/.test(input))
        return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input))
        return true;
    return false;
}
/** Check if input is number-only (not a full identifier or UUID). */
function isNumberOnly(input) {
    return /^\d+$/.test(input);
}
/** Check if an error is critical and should propagate (rate limit / server / timeout). */
function isCriticalError(error) {
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        return (msg.includes("rate limit") ||
            msg.includes("server") ||
            msg.includes("etimedout") ||
            msg.includes("econnrefused") ||
            msg.includes("econnreset"));
    }
    return false;
}
/** Try to get an issue by exact ID/identifier via getIssue.handler; null on (non-critical) miss. */
async function tryExactMatch(id, ctx, propagateErrors = false) {
    try {
        return await getIssue.handler({ id }, ctx);
    }
    catch (error) {
        if (propagateErrors && isCriticalError(error)) {
            throw error;
        }
        return null;
    }
}
/** Search for issues matching the query (title/description contains). */
async function searchIssues(apiKey, query, team, limit = FIND_ISSUE_DEFAULT_MAX_RESULTS) {
    try {
        const filter = {
            or: [{ title: { contains: query } }, { description: { contains: query } }],
        };
        if (team) {
            filter.team = { name: { eq: team } };
        }
        const response = await linearGraphQL(apiKey, SEARCH_ISSUES_QUERY, {
            first: limit,
            filter,
            orderBy: "updatedAt",
        });
        return response.issues.nodes.map((issue) => ({
            identifier: issue.identifier,
            title: issue.title,
            state: issue.state?.name,
            assignee: issue.assignee?.name,
            url: issue.url,
        }));
    }
    catch {
        return [];
    }
}
/** Search for issues whose identifier number contains the supplied number. */
async function searchByNumber(apiKey, numberStr, team, limit = FIND_ISSUE_DEFAULT_MAX_RESULTS) {
    try {
        const filter = {};
        if (team) {
            filter.team = { name: { eq: team } };
        }
        const response = await linearGraphQL(apiKey, SEARCH_ISSUES_QUERY, {
            first: 50,
            filter,
            orderBy: "updatedAt",
        });
        const matching = response.issues.nodes
            .filter((issue) => {
            const identifierNumber = issue.identifier?.split("-")[1];
            return identifierNumber?.includes(numberStr);
        })
            .slice(0, limit);
        return matching.map((issue) => ({
            identifier: issue.identifier,
            title: issue.title,
            state: issue.state?.name,
            assignee: issue.assignee?.name,
            url: issue.url,
        }));
    }
    catch {
        return [];
    }
}
export const findIssue = {
    id: "linear.find_issue",
    name: "Find Linear Issue",
    description: "Smart issue finder - handles partial IDs and searches with disambiguation",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: findIssueInput,
    output: findIssueOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const query = args.query;
        const team = args.team;
        const maxResults = args.maxResults ?? FIND_ISSUE_DEFAULT_MAX_RESULTS;
        // Step 1: Handle identifier-like inputs.
        if (looksLikeIdentifier(query)) {
            if (isNumberOnly(query)) {
                // Try with common team prefixes first.
                const commonPrefixes = ["ENG", "PROD", "DEV"];
                for (const prefix of commonPrefixes) {
                    const fullId = `${prefix}-${query}`;
                    // First attempt (ENG) propagates critical errors.
                    const match = await tryExactMatch(fullId, ctx, prefix === "ENG");
                    if (match) {
                        return { status: "found", issue: match };
                    }
                }
                // Search by number if no prefix match.
                const numberMatches = await searchByNumber(apiKey, query, team, maxResults);
                if (numberMatches.length === 1) {
                    const fullIssue = await tryExactMatch(numberMatches[0].identifier, ctx);
                    if (fullIssue) {
                        return { status: "found", issue: fullIssue };
                    }
                }
                else if (numberMatches.length > 1) {
                    return {
                        status: "disambiguation_needed",
                        message: `Found ${numberMatches.length} issues matching "${query}"`,
                        query,
                        candidates: numberMatches,
                        hint: `Please specify the full identifier (e.g., "${numberMatches[0].identifier}")`,
                    };
                }
            }
            else {
                // Full identifier or UUID - try exact match first (propagate critical errors).
                const exactMatch = await tryExactMatch(query, ctx, true);
                if (exactMatch) {
                    return { status: "found", issue: exactMatch };
                }
            }
        }
        // Step 2: Fall back to text search.
        const searchResults = await searchIssues(apiKey, query, team, maxResults);
        if (searchResults.length === 0) {
            return {
                status: "not_found",
                message: `No issues found matching "${query}"`,
                query,
                suggestions: [
                    "Try a different search term",
                    "Check if the issue exists in a different team",
                    "Use the full issue identifier (e.g., ENG-1234)",
                ],
            };
        }
        if (searchResults.length === 1) {
            const fullIssue = await tryExactMatch(searchResults[0].identifier, ctx);
            if (fullIssue) {
                return { status: "found", issue: fullIssue };
            }
        }
        return {
            status: "disambiguation_needed",
            message: `Found ${searchResults.length} issues matching "${query}"`,
            query,
            candidates: searchResults,
            hint: `Please specify which issue you want by identifier (e.g., "${searchResults[0].identifier}")`,
        };
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.archive_issue
// ════════════════════════════════════════════════════════════════════════════
const ARCHIVE_ISSUE_MUTATION = `
  mutation IssueArchive($id: String!) {
    issueArchive(id: $id) {
      success
      entity {
        id
        identifier
        archivedAt
      }
    }
  }
`;
const archiveIssueInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Issue ID or identifier"),
});
const archiveIssueOutput = z.object({
    success: z.boolean(),
    entity: z.object({
        id: z.string(),
        identifier: z.string(),
        archivedAt: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const archiveIssue = {
    id: "linear.archive_issue",
    name: "Archive Linear Issue",
    description: "Archive an issue in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: archiveIssueInput,
    output: archiveIssueOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, ARCHIVE_ISSUE_MUTATION, {
            id: args.id,
        });
        if (!response.issueArchive?.success || !response.issueArchive?.entity) {
            throw new Error("Failed to archive issue");
        }
        const baseData = {
            success: response.issueArchive.success,
            entity: {
                id: response.issueArchive.entity.id,
                identifier: response.issueArchive.entity.identifier,
                archivedAt: response.issueArchive.entity.archivedAt,
            },
        };
        return archiveIssueOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.unarchive_issue
// ════════════════════════════════════════════════════════════════════════════
const UNARCHIVE_ISSUE_MUTATION = `
  mutation IssueUnarchive($id: String!) {
    issueUnarchive(id: $id) {
      success
      entity {
        id
        identifier
        archivedAt
      }
    }
  }
`;
const unarchiveIssueInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Issue ID or identifier"),
});
const unarchiveIssueOutput = z.object({
    success: z.boolean(),
    entity: z.object({
        id: z.string(),
        identifier: z.string(),
        archivedAt: z.string().nullable(),
    }),
    estimatedTokens: z.number(),
});
export const unarchiveIssue = {
    id: "linear.unarchive_issue",
    name: "Unarchive Linear Issue",
    description: "Unarchive an issue in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: unarchiveIssueInput,
    output: unarchiveIssueOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, UNARCHIVE_ISSUE_MUTATION, {
            id: args.id,
        });
        if (!response.issueUnarchive?.success || !response.issueUnarchive?.entity) {
            throw new Error("Failed to unarchive issue");
        }
        const baseData = {
            success: response.issueUnarchive.success,
            entity: {
                id: response.issueUnarchive.entity.id,
                identifier: response.issueUnarchive.entity.identifier,
                archivedAt: response.issueUnarchive.entity.archivedAt,
            },
        };
        return unarchiveIssueOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// Batch 2 — Projects family (list/get/create/update/delete/archive). Ported from
// the marketplace `core/tools/linear/*-project.ts` files. GraphQL strings, Zod
// shapes, and output maps are carried verbatim; the `init.js` side-effect +
// `createLinearClient()` + `executeGraphQL` + `testToken` are replaced by the
// shared CTX-only `linearGraphQL(apiKey, …)` transport. Prose fields (name /
// description / summary) use `safeText`; ID/filter fields use `safeFilter` (or
// the required-id chain). Only `create_project` resolves a team id
// (`resolveTeamId`); the others pass raw ids, matching the marketplace sources.
// ════════════════════════════════════════════════════════════════════════════
// ── linear.list_projects ─────────────────────────────────────────────────────
const LIST_PROJECTS_QUERY = `
  query Projects($first: Int, $includeArchived: Boolean, $orderBy: PaginationOrderBy) {
    projects(first: $first, includeArchived: $includeArchived, orderBy: $orderBy) {
      nodes {
        id
        name
        description
        content
        state
        lead {
          id
          name
        }
        startDate
        targetDate
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
const listProjectsInput = z.object({
    team: safeFilter("Team name or ID"),
    state: safeFilter("State name or ID"),
    query: safeFilter("Search for content in project name"),
    includeArchived: z.boolean().optional(),
    limit: z.number().min(1).max(250).optional(),
    orderBy: z.enum(["createdAt", "updatedAt"]).optional(),
    fullDescription: z
        .boolean()
        .optional()
        .describe("Return full description without truncation (default: false for token efficiency)"),
    fullContent: z
        .boolean()
        .optional()
        .describe("Return full content without truncation (default: false for token efficiency)"),
});
const LIST_PROJECTS_DEFAULT_LIMIT = 50;
const listProjectsOutput = z.object({
    projects: z.array(z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        content: z.string().optional(),
        state: z.string().optional(),
        lead: z.object({ id: z.string(), name: z.string() }).optional(),
        startDate: z.string().optional(),
        targetDate: z.string().optional(),
        createdAt: z.string(),
        updatedAt: z.string(),
    })),
    totalProjects: z.number(),
    nextOffset: z.string().optional(),
    estimatedTokens: z.number(),
});
export const listProjects = {
    id: "linear.list_projects",
    name: "List Linear Projects",
    description: "List projects from Linear workspace",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listProjectsInput,
    output: listProjectsOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, LIST_PROJECTS_QUERY, {
            first: args.limit ?? LIST_PROJECTS_DEFAULT_LIMIT,
            includeArchived: args.includeArchived ?? false,
            orderBy: args.orderBy ?? "updatedAt",
        });
        const projects = response.projects?.nodes || [];
        const baseData = {
            projects: projects.map((project) => ({
                id: project.id,
                name: project.name,
                description: args.fullDescription
                    ? project.description || undefined
                    : project.description?.substring(0, 200) || undefined,
                content: args.fullContent
                    ? project.content || undefined
                    : project.content?.substring(0, 500) || undefined,
                state: project.state || undefined,
                lead: project.lead ? { id: project.lead.id, name: project.lead.name } : undefined,
                startDate: project.startDate || undefined,
                targetDate: project.targetDate || undefined,
                createdAt: project.createdAt,
                updatedAt: project.updatedAt,
            })),
            totalProjects: projects.length,
            nextOffset: response.projects?.pageInfo?.endCursor || undefined,
        };
        return listProjectsOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ── linear.get_project ───────────────────────────────────────────────────────
const GET_PROJECT_QUERY = `
  query Project($id: String!) {
    project(id: $id) {
      id
      name
      description
      content
      state
      lead {
        id
        name
        email
      }
      startDate
      targetDate
      createdAt
      updatedAt
    }
  }
`;
const getProjectInput = z.object({
    query: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Project ID or name"),
    fullDescription: z
        .boolean()
        .optional()
        .describe("Return full description without truncation (default: false for token efficiency)"),
    fullContent: z
        .boolean()
        .optional()
        .describe("Return full content without truncation (default: false for token efficiency)"),
});
const getProjectOutput = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    content: z.string().optional(),
    state: z.string().optional(),
    lead: z.object({ id: z.string(), name: z.string(), email: z.string() }).optional(),
    startDate: z.string().optional(),
    targetDate: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    estimatedTokens: z.number(),
});
export const getProject = {
    id: "linear.get_project",
    name: "Get Linear Project",
    description: "Get detailed information about a specific Linear project",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: getProjectInput,
    output: getProjectOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, GET_PROJECT_QUERY, {
            id: args.query,
        });
        if (!response.project) {
            throw new Error(`Project not found: ${args.query}`);
        }
        const baseData = {
            id: response.project.id,
            name: response.project.name,
            description: args.fullDescription
                ? response.project.description || undefined
                : response.project.description?.substring(0, 500) || undefined,
            content: args.fullContent
                ? response.project.content || undefined
                : response.project.content?.substring(0, 1000) || undefined,
            state: response.project.state || undefined,
            lead: response.project.lead
                ? {
                    id: response.project.lead.id,
                    name: response.project.lead.name,
                    email: response.project.lead.email,
                }
                : undefined,
            startDate: response.project.startDate || undefined,
            targetDate: response.project.targetDate || undefined,
            createdAt: response.project.createdAt,
            updatedAt: response.project.updatedAt,
        };
        return getProjectOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ── linear.create_project ────────────────────────────────────────────────────
const CREATE_PROJECT_MUTATION = `
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project {
        id
        name
        url
      }
    }
  }
`;
const createProjectInput = z.object({
    name: z
        .string()
        .min(1)
        .refine(noControlCharsAllowWhitespace, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Project name"),
    description: safeText("Full project description (Markdown)").optional(),
    summary: safeText("Concise plaintext summary (max 255 chars)").optional(),
    team: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Team name or ID"),
    lead: safeFilter('User ID, name, email, or "me"'),
    state: safeFilter("State of the project"),
    startDate: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Start date (ISO format)"),
    targetDate: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Target date (ISO format)"),
    priority: z.number().min(0).max(4).optional().describe("0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low"),
    labels: z
        .array(z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected"))
        .optional()
        .describe("Label names or IDs"),
});
const createProjectOutput = z.object({
    success: z.boolean(),
    project: z.object({ id: z.string(), name: z.string(), url: z.string() }),
    estimatedTokens: z.number(),
});
export const createProject = {
    id: "linear.create_project",
    name: "Create Linear Project",
    description: "Create a new project in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createProjectInput,
    output: createProjectOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const teamId = await resolveTeamId(apiKey, args.team);
        const mutationInput = {
            name: args.name,
            teamIds: [teamId],
            // Praetorian workspace default project template - required for all projects
            templateId: "11156350-e6e1-4712-b992-9e5b6e176ee3",
        };
        if (args.description) {
            mutationInput.description = args.description;
        }
        if (args.summary) {
            mutationInput.summary = args.summary;
        }
        if (args.lead) {
            mutationInput.leadId = args.lead;
        }
        if (args.state) {
            mutationInput.stateId = args.state;
        }
        if (args.startDate) {
            mutationInput.startDate = args.startDate;
        }
        if (args.targetDate) {
            mutationInput.targetDate = args.targetDate;
        }
        if (args.priority !== undefined) {
            mutationInput.priority = args.priority;
        }
        if (args.labels) {
            mutationInput.labelIds = args.labels;
        }
        const response = await linearGraphQL(apiKey, CREATE_PROJECT_MUTATION, {
            input: mutationInput,
        });
        if (!response.projectCreate?.success || !response.projectCreate?.project) {
            throw new Error("Failed to create project");
        }
        const baseData = {
            success: response.projectCreate.success,
            project: {
                id: response.projectCreate.project.id,
                name: response.projectCreate.project.name,
                url: response.projectCreate.project.url,
            },
        };
        return createProjectOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ── linear.update_project ────────────────────────────────────────────────────
const UPDATE_PROJECT_MUTATION = `
  mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
      project {
        id
        name
        url
      }
    }
  }
`;
const updateProjectInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Project ID"),
    name: safeText("New name").optional(),
    description: safeText("Full project description (Markdown)").optional(),
    summary: safeText("Concise plaintext summary (max 255 chars)").optional(),
    lead: safeFilter('User ID, name, email, or "me"'),
    state: safeFilter("State of the project"),
    startDate: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Start date (ISO format)"),
    targetDate: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Target date (ISO format)"),
    priority: z.number().min(0).max(4).optional().describe("0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low"),
    labels: z
        .array(z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected"))
        .optional()
        .describe("Label names or IDs"),
});
const updateProjectOutput = z.object({
    success: z.boolean(),
    project: z.object({ id: z.string(), name: z.string(), url: z.string() }),
    estimatedTokens: z.number(),
});
export const updateProject = {
    id: "linear.update_project",
    name: "Update Linear Project",
    description: "Update an existing project in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: updateProjectInput,
    output: updateProjectOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const { id, ...updateInput } = args;
        const response = await linearGraphQL(apiKey, UPDATE_PROJECT_MUTATION, {
            id,
            input: updateInput,
        });
        if (!response.projectUpdate.success) {
            throw new Error("Failed to update project");
        }
        const baseData = {
            success: true,
            project: {
                id: response.projectUpdate.project.id,
                name: response.projectUpdate.project.name,
                url: response.projectUpdate.project.url,
            },
        };
        return updateProjectOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ── linear.delete_project ────────────────────────────────────────────────────
const DELETE_PROJECT_MUTATION = `
  mutation ProjectDelete($id: String!) {
    projectDelete(id: $id) {
      success
    }
  }
`;
const deleteProjectInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Project UUID to delete"),
});
const deleteProjectOutput = z.object({
    success: z.boolean(),
    estimatedTokens: z.number(),
});
export const deleteProject = {
    id: "linear.delete_project",
    name: "Delete Linear Project",
    description: "Delete a project in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: deleteProjectInput,
    output: deleteProjectOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, DELETE_PROJECT_MUTATION, {
            id: args.id,
        });
        if (!response.projectDelete.success) {
            throw new Error("Failed to delete project");
        }
        const baseData = { success: true };
        return deleteProjectOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ── linear.archive_project ───────────────────────────────────────────────────
const ARCHIVE_PROJECT_MUTATION = `
  mutation ProjectArchive($id: String!) {
    projectArchive(id: $id) {
      success
      entity {
        id
        name
        archivedAt
      }
    }
  }
`;
const archiveProjectInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Project ID or name"),
});
const archiveProjectOutput = z.object({
    success: z.boolean(),
    entity: z.object({
        id: z.string(),
        name: z.string(),
        archivedAt: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const archiveProject = {
    id: "linear.archive_project",
    name: "Archive Linear Project",
    description: "Archive a project in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: archiveProjectInput,
    output: archiveProjectOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, ARCHIVE_PROJECT_MUTATION, {
            id: args.id,
        });
        if (!response.projectArchive?.success || !response.projectArchive?.entity) {
            throw new Error("Failed to archive project");
        }
        const baseData = {
            success: response.projectArchive.success,
            entity: {
                id: response.projectArchive.entity.id,
                name: response.projectArchive.entity.name,
                archivedAt: response.projectArchive.entity.archivedAt,
            },
        };
        return archiveProjectOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// Batch 3 — Templates family (list_project_templates / get_template /
// create_project_from_template) and Cycles family (list_cycles / get_cycle /
// create_cycle / update_cycle). Ported from the marketplace
// `core/tools/linear/{list-project-templates,get-template,create-project-from-template,
// list-cycles,get-cycle,create-cycle,update-cycle}.ts`. GraphQL strings, Zod
// shapes, and output maps are carried verbatim; the `init.js` side-effect +
// `createLinearClient()` + `executeGraphQL` + `testToken` are replaced by the
// shared CTX-only `linearGraphQL(apiKey, …)` transport. Only
// `create_project_from_template` resolves a team id (`resolveTeamId`) — matching
// its marketplace source; every other tool passes raw ids (cycles `team`,
// template/cycle/project ids), exactly as the sources do (no resolver added).
// ════════════════════════════════════════════════════════════════════════════
// ── linear.list_project_templates ────────────────────────────────────────────
const LIST_TEMPLATES_QUERY = `
  query Templates {
    templates {
      id
      name
      description
      type
      templateData
      createdAt
      updatedAt
    }
  }
`;
const listProjectTemplatesInput = z.object({
    type: z
        .enum(["project", "issue", "all"])
        .optional()
        .describe('Template type to filter: "project" (default), "issue", or "all"'),
    limit: z
        .number()
        .min(1)
        .max(250)
        .optional()
        .describe("Maximum templates to return (client-side limit)"),
    fullDescription: z
        .boolean()
        .optional()
        .describe("Return full description without truncation (default: false for token efficiency)"),
    includeContent: z
        .boolean()
        .optional()
        .describe("Include parsed template content with all fields (default: false for token efficiency)"),
    projectId: safeFilter("Filter templates by associated project ID from templateData"),
});
const LIST_TEMPLATES_DEFAULT_TYPE = "project";
const LIST_TEMPLATES_DEFAULT_LIMIT = 50;
const listProjectTemplatesOutput = z.object({
    templates: z.array(z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        type: z.string(),
        projectId: z.string().optional(),
        teamId: z.string().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        content: z
            .object({
            title: z.string().optional(),
            descriptionData: z.unknown().optional(),
            descriptionText: z.string().optional(),
            stateId: z.string().optional(),
            statusId: z.string().optional(),
            priority: z.number().optional(),
            labelIds: z.array(z.string()).optional(),
            initiativeIds: z.array(z.string()).optional(),
            memberIds: z.array(z.string()).optional(),
            teamIds: z.array(z.string()).optional(),
            projectMilestones: z.array(z.unknown()).optional(),
            initialIssues: z.array(z.unknown()).optional(),
        })
            .optional(),
    })),
    totalTemplates: z.number(),
    estimatedTokens: z.number(),
});
/** Parse templateData (JSON string or object) into a typed shape; null on failure. */
function parseListedTemplateData(raw) {
    if (!raw)
        return null;
    if (typeof raw === "string") {
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    if (typeof raw === "object") {
        return raw;
    }
    return null;
}
export const listProjectTemplates = {
    id: "linear.list_project_templates",
    name: "List Linear Project Templates",
    description: "List project templates from Linear workspace",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listProjectTemplatesInput,
    output: listProjectTemplatesOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        // API doesn't support variables; returns ALL templates. Filtering is client-side.
        const response = await linearGraphQL(apiKey, LIST_TEMPLATES_QUERY, {});
        let templates = response.templates || [];
        // Apply type filter (client-side).
        const typeFilter = args.type ?? LIST_TEMPLATES_DEFAULT_TYPE;
        if (typeFilter !== "all") {
            templates = templates.filter((t) => t.type === typeFilter);
        }
        // Parse templateData and extract projectId/teamId.
        const templatesWithParsedData = templates.map((template) => {
            const parsedData = parseListedTemplateData(template.templateData);
            return {
                ...template,
                projectId: parsedData?.projectId,
                teamId: parsedData?.teamId,
                parsedData,
            };
        });
        // Apply projectId filter if specified.
        const projectIdFilter = args.projectId;
        const filteredTemplates = projectIdFilter
            ? templatesWithParsedData.filter((t) => t.projectId === projectIdFilter)
            : templatesWithParsedData;
        // Apply client-side limit.
        const limit = args.limit ?? LIST_TEMPLATES_DEFAULT_LIMIT;
        const limitedTemplates = filteredTemplates.slice(0, limit);
        const fullDescription = args.fullDescription ?? false;
        const includeContent = args.includeContent ?? false;
        const baseData = {
            templates: limitedTemplates.map((template) => {
                const parsedData = template.parsedData;
                const templateObj = {
                    id: template.id,
                    name: template.name,
                    description: fullDescription
                        ? template.description || undefined
                        : template.description?.substring(0, 200) || undefined,
                    type: template.type || "unknown",
                    projectId: template.projectId || undefined,
                    teamId: template.teamId || undefined,
                    createdAt: template.createdAt || undefined,
                    updatedAt: template.updatedAt || undefined,
                };
                if (includeContent && parsedData) {
                    templateObj.content = {
                        title: parsedData.title,
                        descriptionData: parsedData.descriptionData,
                        descriptionText: parsedData.descriptionText,
                        stateId: parsedData.stateId,
                        statusId: parsedData.statusId,
                        priority: parsedData.priority,
                        labelIds: parsedData.labelIds,
                        initiativeIds: parsedData.initiativeIds,
                        memberIds: parsedData.memberIds,
                        teamIds: parsedData.teamIds,
                        projectMilestones: parsedData.projectMilestones,
                        initialIssues: parsedData.initialIssues,
                    };
                }
                return templateObj;
            }),
            totalTemplates: limitedTemplates.length,
        };
        return listProjectTemplatesOutput.parse({
            ...baseData,
            estimatedTokens: estimateTokens(baseData),
        });
    },
};
// ── linear.get_template ──────────────────────────────────────────────────────
const GET_TEMPLATE_QUERY = `
  query Template($id: String!) {
    template(id: $id) {
      id
      name
      description
      type
      templateData
      team {
        id
        name
      }
      createdAt
      updatedAt
    }
  }
`;
const getTemplateInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Template ID (UUID)"),
});
const getTemplateOutput = z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["project", "issue", "recurringIssue"]),
    description: z.string().optional(),
    content: z.object({
        title: z.string().optional(),
        descriptionData: z.object({}).passthrough().optional(),
        descriptionText: z.string().optional(),
        stateId: z.string().optional(),
        statusId: z.string().optional(),
        priority: z.number().optional(),
        projectId: z.string().optional(),
        teamId: z.string().optional(),
        labelIds: z.array(z.string()).optional(),
    }),
    team: z.object({ id: z.string(), name: z.string() }).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    estimatedTokens: z.number(),
});
/** Parse templateData (JSON string or object) into a record; empty object on failure. */
function parseTemplateRecord(raw) {
    if (!raw)
        return {};
    if (typeof raw === "string") {
        try {
            return JSON.parse(raw);
        }
        catch {
            return {};
        }
    }
    if (typeof raw === "object") {
        return raw;
    }
    return {};
}
/** Extract plain text from ProseMirror descriptionData. */
function extractPlainText(descriptionData) {
    if (!descriptionData || typeof descriptionData !== "object") {
        return undefined;
    }
    const data = descriptionData;
    if (!data.content || !Array.isArray(data.content)) {
        return undefined;
    }
    const texts = [];
    for (const node of data.content) {
        if (node.content && Array.isArray(node.content)) {
            for (const textNode of node.content) {
                if (textNode.text) {
                    texts.push(textNode.text);
                }
            }
        }
    }
    return texts.length > 0 ? texts.join("\n") : undefined;
}
export const getTemplate = {
    id: "linear.get_template",
    name: "Get Linear Template",
    description: "Get detailed information about a specific Linear template",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: getTemplateInput,
    output: getTemplateOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, GET_TEMPLATE_QUERY, {
            id: args.id,
        });
        if (!response.template) {
            throw new Error(`Template not found: ${args.id}`);
        }
        const parsedData = parseTemplateRecord(response.template.templateData);
        const descriptionText = parsedData.descriptionData
            ? extractPlainText(parsedData.descriptionData)
            : undefined;
        const content = {
            title: typeof parsedData.title === "string" ? parsedData.title : undefined,
            descriptionData: typeof parsedData.descriptionData === "object"
                ? parsedData.descriptionData
                : undefined,
            descriptionText,
            stateId: typeof parsedData.stateId === "string" ? parsedData.stateId : undefined,
            statusId: typeof parsedData.statusId === "string" ? parsedData.statusId : undefined,
            priority: typeof parsedData.priority === "number" ? parsedData.priority : undefined,
            projectId: typeof parsedData.projectId === "string" ? parsedData.projectId : undefined,
            teamId: typeof parsedData.teamId === "string" ? parsedData.teamId : undefined,
            labelIds: Array.isArray(parsedData.labelIds)
                ? parsedData.labelIds
                : undefined,
        };
        const baseData = {
            id: response.template.id,
            name: response.template.name,
            type: (response.template.type || "issue"),
            description: response.template.description || undefined,
            content,
            team: response.template.team
                ? { id: response.template.team.id, name: response.template.team.name }
                : undefined,
            createdAt: response.template.createdAt || "",
            updatedAt: response.template.updatedAt || "",
        };
        return getTemplateOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ── linear.create_project_from_template ──────────────────────────────────────
const CREATE_PROJECT_FROM_TEMPLATE_MUTATION = `
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project {
        id
        name
        url
      }
    }
  }
`;
const createProjectFromTemplateInput = z.object({
    templateId: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Project template ID to create from"),
    name: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .describe("Project name"),
    team: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Team name or ID"),
    description: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Override template description"),
    lead: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe('User ID, name, email, or "me"'),
    startDate: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Override start date (ISO format)"),
    targetDate: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Override target date (ISO format)"),
});
const createProjectFromTemplateOutput = z.object({
    success: z.boolean(),
    project: z.object({ id: z.string(), name: z.string(), url: z.string() }),
    estimatedTokens: z.number(),
});
export const createProjectFromTemplate = {
    id: "linear.create_project_from_template",
    name: "Create Linear Project From Template",
    description: "Create a new project from a template in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createProjectFromTemplateInput,
    output: createProjectFromTemplateOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const teamId = await resolveTeamId(apiKey, args.team);
        const mutationInput = {
            name: args.name,
            teamIds: [teamId],
            templateId: args.templateId,
        };
        if (args.description) {
            mutationInput.description = args.description;
        }
        if (args.lead) {
            mutationInput.leadId = args.lead;
        }
        if (args.startDate) {
            mutationInput.startDate = args.startDate;
        }
        if (args.targetDate) {
            mutationInput.targetDate = args.targetDate;
        }
        const response = await linearGraphQL(apiKey, CREATE_PROJECT_FROM_TEMPLATE_MUTATION, { input: mutationInput });
        if (!response.projectCreate?.success || !response.projectCreate?.project) {
            throw new Error("Failed to create project from template");
        }
        const baseData = {
            success: response.projectCreate.success,
            project: {
                id: response.projectCreate.project.id,
                name: response.projectCreate.project.name,
                url: response.projectCreate.project.url,
            },
        };
        return createProjectFromTemplateOutput.parse({
            ...baseData,
            estimatedTokens: estimateTokens(baseData),
        });
    },
};
// ── linear.list_cycles ───────────────────────────────────────────────────────
const LIST_CYCLES_QUERY = `
  query Cycles($filter: CycleFilter) {
    cycles(filter: $filter) {
      nodes {
        id
        name
        number
        team {
          id
          name
        }
        startsAt
        endsAt
        createdAt
        updatedAt
      }
    }
  }
`;
const listCyclesInput = z.object({
    team: safeFilter("Team name or ID"),
    query: safeFilter("Search query for cycle name"),
    includeArchived: z.boolean().optional(),
    limit: z.number().min(1).max(250).optional(),
});
const listCyclesOutput = z.object({
    cycles: z.array(z.object({
        id: z.string(),
        name: z.string(),
        number: z.number().optional(),
        team: z.object({ id: z.string(), name: z.string() }).optional(),
        startsAt: z.string().optional(),
        endsAt: z.string().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
    })),
    totalCycles: z.number(),
    estimatedTokens: z.number(),
});
export const listCycles = {
    id: "linear.list_cycles",
    name: "List Linear Cycles",
    description: "List cycles from Linear workspace",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listCyclesInput,
    output: listCyclesOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        // Build filter object (Linear API expects a specific CycleFilter shape).
        const filter = {};
        if (args.team) {
            filter.team = { name: { eq: args.team } };
        }
        if (args.query) {
            filter.name = { contains: args.query };
        }
        if (args.includeArchived !== undefined) {
            filter.includeArchived = args.includeArchived;
        }
        const response = await linearGraphQL(apiKey, LIST_CYCLES_QUERY, Object.keys(filter).length > 0 ? { filter } : {});
        const cycles = response.cycles?.nodes || [];
        const baseData = {
            cycles: cycles.map((cycle) => ({
                id: cycle.id,
                name: cycle.name,
                number: cycle.number ?? undefined,
                team: cycle.team ? { id: cycle.team.id, name: cycle.team.name } : undefined,
                startsAt: cycle.startsAt ?? undefined,
                endsAt: cycle.endsAt ?? undefined,
                createdAt: cycle.createdAt ?? undefined,
                updatedAt: cycle.updatedAt ?? undefined,
            })),
            totalCycles: cycles.length,
        };
        return listCyclesOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ── linear.get_cycle ─────────────────────────────────────────────────────────
const GET_CYCLE_QUERY = `
  query Cycle($id: String!) {
    cycle(id: $id) {
      id
      name
      description
      number
      team {
        id
        name
      }
      startsAt
      endsAt
      createdAt
      updatedAt
    }
  }
`;
const getCycleInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Cycle UUID"),
});
const getCycleOutput = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    number: z.number().optional(),
    team: z.object({ id: z.string(), name: z.string() }).optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    estimatedTokens: z.number(),
});
export const getCycle = {
    id: "linear.get_cycle",
    name: "Get Linear Cycle",
    description: "Get detailed information about a specific Linear cycle",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: getCycleInput,
    output: getCycleOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, GET_CYCLE_QUERY, { id: args.id });
        if (!response.cycle) {
            throw new Error(`Cycle not found: ${args.id}`);
        }
        const baseData = {
            id: response.cycle.id,
            name: response.cycle.name,
            description: response.cycle.description ?? undefined,
            number: response.cycle.number ?? undefined,
            team: response.cycle.team
                ? { id: response.cycle.team.id, name: response.cycle.team.name }
                : undefined,
            startsAt: response.cycle.startsAt ?? undefined,
            endsAt: response.cycle.endsAt ?? undefined,
            createdAt: response.cycle.createdAt ?? undefined,
            updatedAt: response.cycle.updatedAt ?? undefined,
        };
        return getCycleOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ── linear.create_cycle ──────────────────────────────────────────────────────
const CREATE_CYCLE_MUTATION = `
  mutation CycleCreate($input: CycleCreateInput!) {
    cycleCreate(input: $input) {
      success
      cycle {
        id
        name
        url
      }
    }
  }
`;
const createCycleInput = z.object({
    name: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .describe("Cycle name"),
    description: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Cycle description"),
    team: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Team name or ID"),
    startsAt: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Start date (ISO format)"),
    endsAt: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("End date (ISO format)"),
});
const createCycleOutput = z.object({
    success: z.boolean(),
    cycle: z.object({ id: z.string(), name: z.string(), url: z.string() }),
    estimatedTokens: z.number(),
});
export const createCycle = {
    id: "linear.create_cycle",
    name: "Create Linear Cycle",
    description: "Create a new cycle in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createCycleInput,
    output: createCycleOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        // Marketplace source passes the validated input through verbatim as the
        // CycleCreateInput (team sent raw — NO resolver). Mirror that behavior.
        const response = await linearGraphQL(apiKey, CREATE_CYCLE_MUTATION, {
            input: args,
        });
        if (!response.cycleCreate.success) {
            throw new Error("Failed to create cycle");
        }
        const baseData = {
            success: true,
            cycle: {
                id: response.cycleCreate.cycle.id,
                name: response.cycleCreate.cycle.name,
                url: response.cycleCreate.cycle.url,
            },
        };
        return createCycleOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ── linear.update_cycle ──────────────────────────────────────────────────────
const UPDATE_CYCLE_MUTATION = `
  mutation UpdateCycle($id: String!, $input: CycleUpdateInput!) {
    cycleUpdate(id: $id, input: $input) {
      success
      cycle {
        id
        name
        number
        team {
          id
          name
        }
        startsAt
        endsAt
        updatedAt
      }
    }
  }
`;
const updateCycleInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Cycle UUID to update"),
    name: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("New name for the cycle"),
    startsAt: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("New start date (ISO format)"),
    endsAt: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("New end date (ISO format)"),
});
const updateCycleOutput = z.object({
    id: z.string(),
    name: z.string(),
    number: z.number().optional(),
    team: z.object({ id: z.string(), name: z.string() }).optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    updatedAt: z.string().optional(),
    estimatedTokens: z.number(),
});
export const updateCycle = {
    id: "linear.update_cycle",
    name: "Update Linear Cycle",
    description: "Update a cycle in Linear workspace",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: updateCycleInput,
    output: updateCycleOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        // Build mutation input (only include fields that were provided).
        const mutationInput = {};
        if (args.name !== undefined)
            mutationInput.name = args.name;
        if (args.startsAt !== undefined)
            mutationInput.startsAt = args.startsAt;
        if (args.endsAt !== undefined)
            mutationInput.endsAt = args.endsAt;
        const response = await linearGraphQL(apiKey, UPDATE_CYCLE_MUTATION, {
            id: args.id,
            input: mutationInput,
        });
        if (!response.cycleUpdate.cycle) {
            throw new Error(`Cycle not found: ${args.id}`);
        }
        const baseData = {
            id: response.cycleUpdate.cycle.id,
            name: response.cycleUpdate.cycle.name,
            number: response.cycleUpdate.cycle.number,
            team: response.cycleUpdate.cycle.team
                ? { id: response.cycleUpdate.cycle.team.id, name: response.cycleUpdate.cycle.team.name }
                : undefined,
            startsAt: response.cycleUpdate.cycle.startsAt,
            endsAt: response.cycleUpdate.cycle.endsAt,
            updatedAt: response.cycleUpdate.cycle.updatedAt,
        };
        return updateCycleOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// Batch 4 — Teams + Users + Comments families. Appended below the Batch 3 block;
// all earlier exports left byte-identical. None of these 6 tools call a resolver
// (verified against the marketplace source): they route raw inputs through
// `linearGraphQL`. `list_teams`/`list_users` apply their limit/orderBy defaults
// in the handler (the gateway `ToolDescriptor` types `input` as `z.ZodType<I>`,
// which forbids `.default()` on input fields — same constraint as `listIssues`).
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// linear.list_teams
// ════════════════════════════════════════════════════════════════════════════
const LIST_TEAMS_QUERY = `
  query ListTeams($filter: TeamFilter, $first: Int, $orderBy: PaginationOrderBy) {
    teams(filter: $filter, first: $first, orderBy: $orderBy) {
      nodes {
        id
        key
        name
        description
        createdAt
        updatedAt
        parent {
          id
          name
        }
      }
    }
  }
`;
const listTeamsInput = z.object({
    query: safeFilter("Search query"),
    includeArchived: z.boolean().optional(),
    limit: z.number().min(1).max(250).optional().describe("Max teams to return (1-250, default 50)"),
    orderBy: z.enum(["createdAt", "updatedAt"]).optional(),
});
const listTeamsOutput = z.object({
    teams: z.array(z.object({
        id: z.string(),
        name: z.string(),
        key: z.string().optional(),
        description: z.string().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        parent: z.object({ id: z.string(), name: z.string() }).optional(),
    })),
    totalTeams: z.number(),
    estimatedTokens: z.number(),
});
const LIST_TEAMS_DEFAULT_LIMIT = 50;
export const listTeams = {
    id: "linear.list_teams",
    name: "List Linear Teams",
    description: "List teams from Linear workspace",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listTeamsInput,
    output: listTeamsOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const variables = {
            first: args.limit ?? LIST_TEAMS_DEFAULT_LIMIT,
            orderBy: args.orderBy ?? "updatedAt",
        };
        if (args.query || args.includeArchived !== undefined) {
            const filter = {};
            if (args.query) {
                filter.name = { contains: args.query };
            }
            if (args.includeArchived !== undefined) {
                filter.includeArchived = args.includeArchived;
            }
            variables.filter = filter;
        }
        const response = await linearGraphQL(apiKey, LIST_TEAMS_QUERY, variables);
        const teams = response.teams?.nodes || [];
        const baseData = {
            teams: teams.map((team) => ({
                id: team.id,
                key: team.key || undefined,
                name: team.name,
                description: team.description?.substring(0, 200) || undefined,
                createdAt: team.createdAt,
                updatedAt: team.updatedAt,
                parent: team.parent ? { id: team.parent.id, name: team.parent.name } : undefined,
            })),
            totalTeams: teams.length,
        };
        return listTeamsOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.get_team
// ════════════════════════════════════════════════════════════════════════════
const GET_TEAM_QUERY = `
  query Team($id: String!) {
    team(id: $id) {
      id
      key
      name
      description
      createdAt
      updatedAt
    }
  }
`;
const getTeamInput = z.object({
    query: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Team UUID, key, or name"),
});
const getTeamOutput = z.object({
    id: z.string(),
    key: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    estimatedTokens: z.number(),
});
export const getTeam = {
    id: "linear.get_team",
    name: "Get Linear Team",
    description: "Get detailed information about a specific Linear team",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: getTeamInput,
    output: getTeamOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, GET_TEAM_QUERY, { id: args.query });
        if (!response.team) {
            throw new Error(`Team not found: ${args.query}`);
        }
        const baseData = {
            id: response.team.id,
            key: response.team.key || undefined,
            name: response.team.name,
            description: response.team.description?.substring(0, 500),
            createdAt: response.team.createdAt,
            updatedAt: response.team.updatedAt,
        };
        return getTeamOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.list_users
// ════════════════════════════════════════════════════════════════════════════
const LIST_USERS_QUERY = `
  query Users {
    users {
      nodes {
        id
        name
        email
        active
        createdAt
      }
    }
  }
`;
const listUsersInput = z.object({
    query: safeFilter("Filter by name or email"),
});
const listUsersOutput = z.object({
    users: z.array(z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
        active: z.boolean().optional(),
        createdAt: z.string().optional(),
    })),
    totalUsers: z.number(),
    estimatedTokens: z.number(),
});
export const listUsers = {
    id: "linear.list_users",
    name: "List Linear Users",
    description: "List users from Linear workspace",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listUsersInput,
    output: listUsersOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, LIST_USERS_QUERY, {});
        const users = response.users?.nodes || [];
        // Client-side filtering if query provided (matches marketplace behavior).
        const filteredUsers = args.query
            ? users.filter((user) => user.name.toLowerCase().includes(args.query.toLowerCase()) ||
                user.email.toLowerCase().includes(args.query.toLowerCase()))
            : users;
        const baseData = {
            users: filteredUsers.map((user) => ({
                id: user.id,
                name: user.name,
                email: user.email,
                active: user.active ?? undefined,
                createdAt: user.createdAt ?? undefined,
            })),
            totalUsers: filteredUsers.length,
        };
        return listUsersOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.find_user
// ════════════════════════════════════════════════════════════════════════════
const FIND_USER_QUERY = `
  query Users($filter: UserFilter) {
    users(filter: $filter, first: 1) {
      nodes {
        id
        name
        email
        displayName
        avatarUrl
        active
        admin
        createdAt
      }
    }
  }
`;
const findUserInput = z.object({
    query: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("User ID, email, or name to search"),
});
const findUserOutput = z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    displayName: z.string().optional(),
    avatarUrl: z.string().optional(),
    active: z.boolean().optional(),
    admin: z.boolean().optional(),
    createdAt: z.string().optional(),
    estimatedTokens: z.number(),
});
export const findUser = {
    id: "linear.find_user",
    name: "Find Linear User",
    description: "Find a specific user in Linear workspace",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: findUserInput,
    output: findUserOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, FIND_USER_QUERY, {
            filter: {
                or: [
                    { email: { containsIgnoreCase: args.query } },
                    { name: { containsIgnoreCase: args.query } },
                    { displayName: { containsIgnoreCase: args.query } },
                ],
            },
        });
        const users = response.users?.nodes || [];
        if (users.length === 0) {
            throw new Error(`User not found: ${args.query}`);
        }
        const user = users[0];
        const baseData = {
            id: user.id,
            name: user.name,
            email: user.email,
            displayName: user.displayName || undefined,
            avatarUrl: user.avatarUrl || undefined,
            active: user.active ?? undefined,
            admin: user.admin ?? undefined,
            createdAt: user.createdAt || undefined,
        };
        return findUserOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.list_comments
// ════════════════════════════════════════════════════════════════════════════
const LIST_COMMENTS_QUERY = `
  query IssueComments($id: String!) {
    issue(id: $id) {
      id
      comments {
        nodes {
          id
          body
          user {
            id
            name
            email
          }
          createdAt
          updatedAt
        }
      }
    }
  }
`;
const listCommentsInput = z.object({
    issueId: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Issue ID or identifier"),
});
const listCommentsOutput = z.object({
    comments: z.array(z.object({
        id: z.string(),
        body: z.string(),
        user: z.object({ id: z.string(), name: z.string(), email: z.string() }).optional(),
        createdAt: z.string(),
        updatedAt: z.string(),
    })),
    totalComments: z.number(),
    estimatedTokens: z.number(),
});
export const listComments = {
    id: "linear.list_comments",
    name: "List Linear Comments",
    description: "List comments for a specific Linear issue",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listCommentsInput,
    output: listCommentsOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, LIST_COMMENTS_QUERY, {
            id: args.issueId,
        });
        if (!response.issue) {
            throw new Error(`Issue not found: ${args.issueId}`);
        }
        const comments = response.issue.comments?.nodes || [];
        const baseData = {
            comments: comments.map((comment) => ({
                id: comment.id,
                body: comment.body?.substring(0, 300) || "",
                user: comment.user
                    ? { id: comment.user.id, name: comment.user.name, email: comment.user.email }
                    : undefined,
                createdAt: comment.createdAt || "",
                updatedAt: comment.updatedAt || "",
            })),
            totalComments: comments.length,
        };
        return listCommentsOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.create_comment
// ════════════════════════════════════════════════════════════════════════════
const CREATE_COMMENT_MUTATION = `
  mutation CommentCreate($issueId: String!, $body: String!, $parentId: String) {
    commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) {
      success
      comment {
        id
        body
        createdAt
      }
    }
  }
`;
const createCommentInput = z.object({
    issueId: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Issue ID or identifier"),
    // User content - only block control chars (allow whitespace), like the marketplace source.
    body: z
        .string()
        .min(1)
        .refine(noControlCharsAllowWhitespace, "Control characters not allowed")
        .describe("Comment content (Markdown)"),
    parentId: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Parent comment ID (for replies)"),
});
const createCommentOutput = z.object({
    success: z.boolean(),
    comment: z.object({
        id: z.string(),
        body: z.string(),
        createdAt: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const createComment = {
    id: "linear.create_comment",
    name: "Create Linear Comment",
    description: "Create a comment on a Linear issue",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createCommentInput,
    output: createCommentOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, CREATE_COMMENT_MUTATION, {
            issueId: args.issueId,
            body: args.body,
            parentId: args.parentId,
        });
        if (!response.commentCreate?.success || !response.commentCreate?.comment) {
            throw new Error("Failed to create comment");
        }
        const baseData = {
            success: response.commentCreate.success,
            comment: {
                id: response.commentCreate.comment.id,
                body: response.commentCreate.comment.body,
                createdAt: response.commentCreate.comment.createdAt,
            },
        };
        return createCommentOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// Batch 5 — Labels family (list/get/create/update/delete) and Workflow States
// family (list/get/create/update). Appended below the reviewed Comments block;
// all prior exports are left byte-identical. Per grep ground truth NONE of these
// call a resolver: create_label / create_workflow_state accept a RAW teamId
// (and create_label a raw parentId) exactly as the marketplace sources do.
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// linear.list_labels
// ════════════════════════════════════════════════════════════════════════════
const LIST_LABELS_QUERY = `
  query IssueLabels($first: Int, $filter: IssueLabelFilter) {
    issueLabels(first: $first, filter: $filter) {
      nodes {
        id
        name
        description
        color
        isGroup
        parent { id }
        team { id }
      }
    }
  }
`;
const listLabelsInput = z.object({
    teamId: safeFilter("Filter by team ID"),
    limit: z.number().min(1).max(250).optional().describe("Number of results"),
    includeArchived: z.boolean().optional(),
});
const LABELS_DEFAULT_LIMIT = 100;
const listLabelsOutput = z.object({
    labels: z.array(z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        color: z.string(),
        isGroup: z.boolean().optional(),
        parentId: z.string().optional(),
        teamId: z.string().optional(),
    })),
    totalLabels: z.number(),
    estimatedTokens: z.number(),
});
export const listLabels = {
    id: "linear.list_labels",
    name: "List Linear Labels",
    description: "List issue labels from Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listLabelsInput,
    output: listLabelsOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const filter = {};
        if (args.teamId) {
            filter.team = { id: { eq: args.teamId } };
        }
        const response = await linearGraphQL(apiKey, LIST_LABELS_QUERY, {
            first: args.limit ?? LABELS_DEFAULT_LIMIT,
            filter: Object.keys(filter).length ? filter : undefined,
        });
        const labels = response.issueLabels?.nodes || [];
        const baseData = {
            labels: labels.map((label) => ({
                id: label.id,
                name: label.name,
                description: label.description || undefined,
                color: label.color,
                isGroup: label.isGroup,
                parentId: label.parent?.id,
                teamId: label.team?.id,
            })),
            totalLabels: labels.length,
        };
        return listLabelsOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.get_label
// ════════════════════════════════════════════════════════════════════════════
const GET_LABEL_QUERY = `
  query IssueLabel($id: String!) {
    issueLabel(id: $id) {
      id
      name
      description
      color
      isGroup
      parent { id name }
      team { id name }
    }
  }
`;
const getLabelInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Label ID"),
});
const getLabelOutput = z.object({
    label: z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        color: z.string(),
        isGroup: z.boolean().optional(),
        parentId: z.string().optional(),
        parentName: z.string().optional(),
        teamId: z.string().optional(),
        teamName: z.string().optional(),
    }),
    estimatedTokens: z.number(),
});
export const getLabel = {
    id: "linear.get_label",
    name: "Get Linear Label",
    description: "Get a label by ID from Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: getLabelInput,
    output: getLabelOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, GET_LABEL_QUERY, {
            id: args.id,
        });
        if (!response.issueLabel) {
            throw new Error(`Label not found: ${args.id}`);
        }
        const label = response.issueLabel;
        const baseData = {
            label: {
                id: label.id,
                name: label.name,
                description: label.description || undefined,
                color: label.color,
                isGroup: label.isGroup,
                parentId: label.parent?.id,
                parentName: label.parent?.name,
                teamId: label.team?.id,
                teamName: label.team?.name,
            },
        };
        return getLabelOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.create_label  (accepts RAW teamId / parentId — no resolver, per source)
// ════════════════════════════════════════════════════════════════════════════
const CREATE_LABEL_MUTATION = `
  mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      success
      issueLabel {
        id
        name
        color
      }
    }
  }
`;
const createLabelInput = z.object({
    name: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .describe("Label name"),
    color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Must be hex color (e.g., #ff0000)")
        .optional()
        .describe("Hex color code"),
    description: z
        .string()
        .refine(noControlCharsAllowWhitespace, "Dangerous control characters not allowed")
        .optional()
        .describe("Label description"),
    teamId: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Team ID to scope label"),
    parentId: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Parent label ID for grouping"),
});
const createLabelOutput = z.object({
    success: z.boolean(),
    label: z.object({
        id: z.string(),
        name: z.string(),
        color: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const createLabel = {
    id: "linear.create_label",
    name: "Create Linear Label",
    description: "Create a new label in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createLabelInput,
    output: createLabelOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const mutationInput = {
            name: args.name,
        };
        if (args.color)
            mutationInput.color = args.color;
        if (args.description)
            mutationInput.description = args.description;
        if (args.teamId)
            mutationInput.teamId = args.teamId;
        if (args.parentId)
            mutationInput.parentId = args.parentId;
        const response = await linearGraphQL(apiKey, CREATE_LABEL_MUTATION, {
            input: mutationInput,
        });
        if (!response.issueLabelCreate?.success || !response.issueLabelCreate?.issueLabel) {
            throw new Error("Failed to create label");
        }
        const baseData = {
            success: response.issueLabelCreate.success,
            label: {
                id: response.issueLabelCreate.issueLabel.id,
                name: response.issueLabelCreate.issueLabel.name,
                color: response.issueLabelCreate.issueLabel.color,
            },
        };
        return createLabelOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.update_label
// ════════════════════════════════════════════════════════════════════════════
const UPDATE_LABEL_MUTATION = `
  mutation IssueLabelUpdate($id: String!, $input: IssueLabelUpdateInput!) {
    issueLabelUpdate(id: $id, input: $input) {
      success
      issueLabel {
        id
        name
        color
      }
    }
  }
`;
const updateLabelInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Label ID"),
    name: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Label name"),
    color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Must be hex color (e.g., #ff0000)")
        .optional()
        .describe("Hex color code"),
    description: z
        .string()
        .refine(noControlCharsAllowWhitespace, "Dangerous control characters not allowed")
        .optional()
        .describe("Label description"),
});
const updateLabelOutput = z.object({
    success: z.boolean(),
    label: z.object({
        id: z.string(),
        name: z.string(),
        color: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const updateLabel = {
    id: "linear.update_label",
    name: "Update Linear Label",
    description: "Update a label in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: updateLabelInput,
    output: updateLabelOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const mutationInput = {};
        if (args.name)
            mutationInput.name = args.name;
        if (args.color)
            mutationInput.color = args.color;
        if (args.description)
            mutationInput.description = args.description;
        const response = await linearGraphQL(apiKey, UPDATE_LABEL_MUTATION, {
            id: args.id,
            input: mutationInput,
        });
        if (!response.issueLabelUpdate?.success || !response.issueLabelUpdate?.issueLabel) {
            throw new Error("Failed to update label");
        }
        const baseData = {
            success: response.issueLabelUpdate.success,
            label: {
                id: response.issueLabelUpdate.issueLabel.id,
                name: response.issueLabelUpdate.issueLabel.name,
                color: response.issueLabelUpdate.issueLabel.color,
            },
        };
        return updateLabelOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.delete_label
// ════════════════════════════════════════════════════════════════════════════
const DELETE_LABEL_MUTATION = `
  mutation IssueLabelDelete($id: String!) {
    issueLabelDelete(id: $id) {
      success
    }
  }
`;
const deleteLabelInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Label ID"),
});
const deleteLabelOutput = z.object({
    success: z.boolean(),
    estimatedTokens: z.number(),
});
export const deleteLabel = {
    id: "linear.delete_label",
    name: "Delete Linear Label",
    description: "Delete a label from Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: deleteLabelInput,
    output: deleteLabelOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, DELETE_LABEL_MUTATION, {
            id: args.id,
        });
        if (!response.issueLabelDelete?.success) {
            throw new Error("Failed to delete label");
        }
        const baseData = {
            success: response.issueLabelDelete.success,
        };
        return deleteLabelOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.list_workflow_states
// ════════════════════════════════════════════════════════════════════════════
const LIST_WORKFLOW_STATES_QUERY = `
  query WorkflowStates($first: Int, $filter: WorkflowStateFilter) {
    workflowStates(first: $first, filter: $filter) {
      nodes {
        id
        name
        type
        color
        position
        description
        team {
          id
          name
        }
      }
    }
  }
`;
const listWorkflowStatesInput = z.object({
    filter: z
        .object({
        teamId: safeFilter("Filter by team ID"),
    })
        .optional()
        .describe("Filter options"),
    limit: z.number().min(1).max(250).optional().describe("Number of results"),
});
const WORKFLOW_STATES_DEFAULT_LIMIT = 100;
const listWorkflowStatesOutput = z.object({
    workflowStates: z.array(z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        color: z.string(),
        position: z.number(),
        description: z.string().optional(),
        teamId: z.string().optional(),
        teamName: z.string().optional(),
    })),
    totalStates: z.number(),
    estimatedTokens: z.number(),
});
export const listWorkflowStates = {
    id: "linear.list_workflow_states",
    name: "List Linear Workflow States",
    description: "List workflow states from Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listWorkflowStatesInput,
    output: listWorkflowStatesOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const filter = {};
        if (args.filter?.teamId) {
            filter.team = { id: { eq: args.filter.teamId } };
        }
        const response = await linearGraphQL(apiKey, LIST_WORKFLOW_STATES_QUERY, {
            first: args.limit ?? WORKFLOW_STATES_DEFAULT_LIMIT,
            filter: Object.keys(filter).length ? filter : undefined,
        });
        const states = response.workflowStates?.nodes || [];
        const baseData = {
            workflowStates: states.map((state) => ({
                id: state.id,
                name: state.name,
                type: state.type,
                color: state.color,
                position: state.position,
                description: state.description || undefined,
                teamId: state.team?.id,
                teamName: state.team?.name,
            })),
            totalStates: states.length,
        };
        return listWorkflowStatesOutput.parse({
            ...baseData,
            estimatedTokens: estimateTokens(baseData),
        });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.get_workflow_state
// ════════════════════════════════════════════════════════════════════════════
const GET_WORKFLOW_STATE_QUERY = `
  query WorkflowState($id: String!) {
    workflowState(id: $id) {
      id
      name
      type
      color
      position
      description
      team {
        id
        name
      }
    }
  }
`;
const getWorkflowStateInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Workflow state ID"),
});
const getWorkflowStateOutput = z.object({
    workflowState: z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        color: z.string(),
        position: z.number(),
        description: z.string().optional(),
        teamId: z.string().optional(),
        teamName: z.string().optional(),
    }),
    estimatedTokens: z.number(),
});
export const getWorkflowState = {
    id: "linear.get_workflow_state",
    name: "Get Linear Workflow State",
    description: "Get a workflow state by ID from Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: getWorkflowStateInput,
    output: getWorkflowStateOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, GET_WORKFLOW_STATE_QUERY, {
            id: args.id,
        });
        if (!response.workflowState) {
            throw new Error(`Workflow state not found: ${args.id}`);
        }
        const state = response.workflowState;
        const baseData = {
            workflowState: {
                id: state.id,
                name: state.name,
                type: state.type,
                color: state.color,
                position: state.position,
                description: state.description || undefined,
                teamId: state.team?.id,
                teamName: state.team?.name,
            },
        };
        return getWorkflowStateOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.create_workflow_state  (accepts RAW teamId — no resolver, per source)
// ════════════════════════════════════════════════════════════════════════════
const CREATE_WORKFLOW_STATE_MUTATION = `
  mutation WorkflowStateCreate($input: WorkflowStateCreateInput!) {
    workflowStateCreate(input: $input) {
      success
      workflowState {
        id
        name
        type
        color
      }
    }
  }
`;
const createWorkflowStateInput = z.object({
    name: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .describe("State name"),
    type: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]).describe("State type"),
    teamId: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Team ID to scope state"),
    color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Must be hex color (e.g., #f2c94c)")
        .optional()
        .describe("Hex color code"),
    position: z.number().min(0).optional().describe("Sort position"),
    description: z
        .string()
        .refine(noControlCharsAllowWhitespace, "Dangerous control characters not allowed")
        .optional()
        .describe("State description"),
});
const createWorkflowStateOutput = z.object({
    success: z.boolean(),
    workflowState: z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        color: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const createWorkflowState = {
    id: "linear.create_workflow_state",
    name: "Create Linear Workflow State",
    description: "Create a new workflow state in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createWorkflowStateInput,
    output: createWorkflowStateOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const mutationInput = {
            name: args.name,
            type: args.type,
            teamId: args.teamId,
        };
        if (args.color)
            mutationInput.color = args.color;
        if (args.position !== undefined)
            mutationInput.position = args.position;
        if (args.description)
            mutationInput.description = args.description;
        const response = await linearGraphQL(apiKey, CREATE_WORKFLOW_STATE_MUTATION, { input: mutationInput });
        if (!response.workflowStateCreate?.success || !response.workflowStateCreate?.workflowState) {
            throw new Error("Failed to create workflow state");
        }
        const baseData = {
            success: response.workflowStateCreate.success,
            workflowState: {
                id: response.workflowStateCreate.workflowState.id,
                name: response.workflowStateCreate.workflowState.name,
                type: response.workflowStateCreate.workflowState.type,
                color: response.workflowStateCreate.workflowState.color,
            },
        };
        return createWorkflowStateOutput.parse({
            ...baseData,
            estimatedTokens: estimateTokens(baseData),
        });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.update_workflow_state
// ════════════════════════════════════════════════════════════════════════════
const UPDATE_WORKFLOW_STATE_MUTATION = `
  mutation WorkflowStateUpdate($id: String!, $input: WorkflowStateUpdateInput!) {
    workflowStateUpdate(id: $id, input: $input) {
      success
      workflowState {
        id
        name
        type
        color
      }
    }
  }
`;
const updateWorkflowStateInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Workflow state ID"),
    name: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Updated state name"),
    color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Must be hex color (e.g., #f2c94c)")
        .optional()
        .describe("Updated hex color code"),
    position: z.number().min(0).optional().describe("Updated sort position"),
    description: z
        .string()
        .refine(noControlCharsAllowWhitespace, "Dangerous control characters not allowed")
        .optional()
        .describe("Updated state description"),
});
const updateWorkflowStateOutput = z.object({
    success: z.boolean(),
    workflowState: z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        color: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const updateWorkflowState = {
    id: "linear.update_workflow_state",
    name: "Update Linear Workflow State",
    description: "Update a workflow state in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: updateWorkflowStateInput,
    output: updateWorkflowStateOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const mutationInput = {};
        if (args.name)
            mutationInput.name = args.name;
        if (args.color)
            mutationInput.color = args.color;
        if (args.position !== undefined)
            mutationInput.position = args.position;
        if (args.description)
            mutationInput.description = args.description;
        const response = await linearGraphQL(apiKey, UPDATE_WORKFLOW_STATE_MUTATION, { id: args.id, input: mutationInput });
        if (!response.workflowStateUpdate?.success || !response.workflowStateUpdate?.workflowState) {
            throw new Error("Failed to update workflow state");
        }
        const baseData = {
            success: response.workflowStateUpdate.success,
            workflowState: {
                id: response.workflowStateUpdate.workflowState.id,
                name: response.workflowStateUpdate.workflowState.name,
                type: response.workflowStateUpdate.workflowState.type,
                color: response.workflowStateUpdate.workflowState.color,
            },
        };
        return updateWorkflowStateOutput.parse({
            ...baseData,
            estimatedTokens: estimateTokens(baseData),
        });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// Batch 6 — Attachments + Reactions + Subscribers + Favorites families.
// Ported verbatim from the marketplace wrappers (list-attachments, create/update/
// delete-attachment, create/delete-reaction, subscribe/unsubscribe-from-issue,
// create/delete-favorite). All raw-id passthrough (NO resolver calls), shallow
// mutation/delete. Reuses shared helpers: linearGraphQL, estimateTokens,
// noControlChars/noPathTraversal/noCommandInjection. The marketplace
// validateNo* validators map 1:1 onto the inlined no* predicates (O8 contract).
// `.default()` is forbidden on input fields (DEFAULT_LIMIT applied in handler).
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// linear.list_attachments
// ════════════════════════════════════════════════════════════════════════════
const LIST_ATTACHMENTS_QUERY = `
  query Attachments($first: Int, $filter: AttachmentFilter) {
    attachments(first: $first, filter: $filter) {
      nodes {
        id
        title
        subtitle
        url
        metadata
        source
        sourceType
        issue { id }
        creator { id }
        createdAt
        updatedAt
      }
    }
  }
`;
const listAttachmentsInput = z.object({
    filter: z
        .object({
        issueId: z
            .string()
            .refine(noControlChars, "Control characters not allowed")
            .refine(noPathTraversal, "Path traversal not allowed")
            .refine(noCommandInjection, "Invalid characters detected")
            .optional()
            .describe("Filter by issue ID"),
    })
        .optional(),
    limit: z.number().min(1).max(250).optional().describe("Number of results"),
});
const LIST_ATTACHMENTS_DEFAULT_LIMIT = 100;
const listAttachmentsOutput = z.object({
    attachments: z.array(z.object({
        id: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string(),
        source: z.union([z.string(), z.object({ type: z.string() })]),
        sourceType: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        issueId: z.string().optional(),
        creatorId: z.string().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
    })),
    totalAttachments: z.number(),
    estimatedTokens: z.number(),
});
export const listAttachments = {
    id: "linear.list_attachments",
    name: "List Linear Attachments",
    description: "List attachments from Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listAttachmentsInput,
    output: listAttachmentsOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const filter = {};
        if (args.filter?.issueId) {
            filter.issue = { id: { eq: args.filter.issueId } };
        }
        const response = await linearGraphQL(apiKey, LIST_ATTACHMENTS_QUERY, {
            first: args.limit ?? LIST_ATTACHMENTS_DEFAULT_LIMIT,
            filter: Object.keys(filter).length > 0 ? filter : undefined,
        });
        const attachments = response.attachments?.nodes || [];
        const baseData = {
            attachments: attachments.map((att) => ({
                id: att.id,
                title: att.title,
                subtitle: att.subtitle || undefined,
                url: att.url,
                source: att.source,
                sourceType: att.sourceType || undefined,
                metadata: att.metadata || undefined,
                issueId: att.issue?.id,
                creatorId: att.creator?.id,
                createdAt: att.createdAt || undefined,
                updatedAt: att.updatedAt || undefined,
            })),
            totalAttachments: attachments.length,
        };
        return listAttachmentsOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.create_attachment
// ════════════════════════════════════════════════════════════════════════════
const CREATE_ATTACHMENT_MUTATION = `
  mutation AttachmentCreate($input: AttachmentCreateInput!) {
    attachmentCreate(input: $input) {
      success
      attachment {
        id
        title
        url
      }
    }
  }
`;
const createAttachmentInput = z.object({
    issueId: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Issue ID to attach to"),
    title: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .describe("Attachment title"),
    subtitle: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Attachment subtitle"),
    url: z
        .string()
        .url("Must be valid URL")
        .regex(/^https?:\/\//, "Must be http or https URL")
        .describe("URL to the attachment"),
    metadata: z.record(z.unknown()).optional().describe("Additional metadata"),
});
const createAttachmentOutput = z.object({
    success: z.boolean(),
    attachment: z.object({
        id: z.string(),
        title: z.string(),
        url: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const createAttachment = {
    id: "linear.create_attachment",
    name: "Create Linear Attachment",
    description: "Create a new attachment in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createAttachmentInput,
    output: createAttachmentOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const mutationInput = {
            issueId: args.issueId,
            title: args.title,
            url: args.url,
        };
        if (args.subtitle)
            mutationInput.subtitle = args.subtitle;
        if (args.metadata)
            mutationInput.metadata = args.metadata;
        const response = await linearGraphQL(apiKey, CREATE_ATTACHMENT_MUTATION, { input: mutationInput });
        if (!response.attachmentCreate?.success || !response.attachmentCreate?.attachment) {
            throw new Error("Failed to create attachment");
        }
        const baseData = {
            success: response.attachmentCreate.success,
            attachment: {
                id: response.attachmentCreate.attachment.id,
                title: response.attachmentCreate.attachment.title,
                url: response.attachmentCreate.attachment.url,
            },
        };
        return createAttachmentOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.update_attachment
// ════════════════════════════════════════════════════════════════════════════
const UPDATE_ATTACHMENT_MUTATION = `
  mutation AttachmentUpdate($id: String!, $input: AttachmentUpdateInput!) {
    attachmentUpdate(id: $id, input: $input) {
      success
      attachment {
        id
        title
        url
      }
    }
  }
`;
const updateAttachmentInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Attachment ID"),
    title: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Updated attachment title"),
    subtitle: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Updated attachment subtitle"),
    metadata: z.record(z.unknown()).optional().describe("Updated metadata"),
});
const updateAttachmentOutput = z.object({
    success: z.boolean(),
    attachment: z.object({
        id: z.string(),
        title: z.string(),
        url: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const updateAttachment = {
    id: "linear.update_attachment",
    name: "Update Linear Attachment",
    description: "Update an attachment in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: updateAttachmentInput,
    output: updateAttachmentOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const mutationInput = {};
        if (args.title !== undefined)
            mutationInput.title = args.title;
        if (args.subtitle !== undefined)
            mutationInput.subtitle = args.subtitle;
        if (args.metadata !== undefined)
            mutationInput.metadata = args.metadata;
        const response = await linearGraphQL(apiKey, UPDATE_ATTACHMENT_MUTATION, { id: args.id, input: mutationInput });
        if (!response.attachmentUpdate?.success || !response.attachmentUpdate?.attachment) {
            throw new Error("Failed to update attachment");
        }
        const baseData = {
            success: response.attachmentUpdate.success,
            attachment: {
                id: response.attachmentUpdate.attachment.id,
                title: response.attachmentUpdate.attachment.title,
                url: response.attachmentUpdate.attachment.url,
            },
        };
        return updateAttachmentOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.delete_attachment
// ════════════════════════════════════════════════════════════════════════════
const DELETE_ATTACHMENT_MUTATION = `
  mutation AttachmentDelete($id: String!) {
    attachmentDelete(id: $id) {
      success
    }
  }
`;
const deleteAttachmentInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Attachment ID to delete"),
});
const deleteAttachmentOutput = z.object({
    success: z.boolean(),
    estimatedTokens: z.number(),
});
export const deleteAttachment = {
    id: "linear.delete_attachment",
    name: "Delete Linear Attachment",
    description: "Delete an attachment from Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: deleteAttachmentInput,
    output: deleteAttachmentOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, DELETE_ATTACHMENT_MUTATION, { id: args.id });
        const baseData = {
            success: response.attachmentDelete.success,
        };
        return deleteAttachmentOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.create_reaction
// ════════════════════════════════════════════════════════════════════════════
const CREATE_REACTION_MUTATION = `
  mutation ReactionCreate($input: ReactionCreateInput!) {
    reactionCreate(input: $input) {
      success
      reaction {
        id
        emoji
        user {
          id
          name
        }
        comment {
          id
        }
      }
    }
  }
`;
const createReactionInput = z.object({
    commentId: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Comment ID to add reaction to"),
    emoji: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .describe("Emoji character(s) for reaction"),
});
const createReactionOutput = z.object({
    success: z.boolean(),
    reaction: z.object({
        id: z.string(),
        emoji: z.string(),
        user: z.object({
            id: z.string(),
            name: z.string(),
        }),
        commentId: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const createReaction = {
    id: "linear.create_reaction",
    name: "Create Linear Reaction",
    description: "Create an emoji reaction on a comment in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createReactionInput,
    output: createReactionOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, CREATE_REACTION_MUTATION, {
            input: {
                commentId: args.commentId,
                emoji: args.emoji,
            },
        });
        if (!response.reactionCreate?.success || !response.reactionCreate?.reaction) {
            throw new Error("Failed to create reaction");
        }
        const baseData = {
            success: response.reactionCreate.success,
            reaction: {
                id: response.reactionCreate.reaction.id,
                emoji: response.reactionCreate.reaction.emoji,
                user: {
                    id: response.reactionCreate.reaction.user.id,
                    name: response.reactionCreate.reaction.user.name,
                },
                commentId: response.reactionCreate.reaction.comment.id,
            },
        };
        return createReactionOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.delete_reaction
// ════════════════════════════════════════════════════════════════════════════
const DELETE_REACTION_MUTATION = `
  mutation ReactionDelete($id: String!) {
    reactionDelete(id: $id) {
      success
    }
  }
`;
const deleteReactionInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Reaction ID to delete"),
});
const deleteReactionOutput = z.object({
    success: z.boolean(),
    estimatedTokens: z.number(),
});
export const deleteReaction = {
    id: "linear.delete_reaction",
    name: "Delete Linear Reaction",
    description: "Delete an emoji reaction from a comment in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: deleteReactionInput,
    output: deleteReactionOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, DELETE_REACTION_MUTATION, {
            id: args.id,
        });
        if (!response.reactionDelete?.success) {
            throw new Error("Failed to delete reaction");
        }
        const baseData = {
            success: response.reactionDelete.success,
        };
        return deleteReactionOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.subscribe_to_issue
// ════════════════════════════════════════════════════════════════════════════
const SUBSCRIBE_TO_ISSUE_MUTATION = `
  mutation IssueSubscribe($issueId: String!, $userId: String) {
    issueSubscribe(id: $issueId, userId: $userId) {
      success
      issue {
        id
        identifier
        subscribers {
          nodes {
            id
            name
          }
        }
      }
    }
  }
`;
const subscribeToIssueInput = z.object({
    issueId: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Issue ID to subscribe to"),
    userId: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("User ID to subscribe (defaults to current user)"),
});
const subscribeToIssueOutput = z.object({
    success: z.boolean(),
    issue: z.object({
        id: z.string(),
        identifier: z.string(),
        subscribers: z.array(z.object({
            id: z.string(),
            name: z.string(),
        })),
    }),
    estimatedTokens: z.number(),
});
export const subscribeToIssue = {
    id: "linear.subscribe_to_issue",
    name: "Subscribe to Linear Issue",
    description: "Subscribe to issue notifications in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: subscribeToIssueInput,
    output: subscribeToIssueOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, SUBSCRIBE_TO_ISSUE_MUTATION, { issueId: args.issueId, userId: args.userId });
        if (!response.issueSubscribe?.success || !response.issueSubscribe?.issue) {
            throw new Error("Failed to subscribe to issue");
        }
        const issue = response.issueSubscribe.issue;
        const baseData = {
            success: response.issueSubscribe.success,
            issue: {
                id: issue.id,
                identifier: issue.identifier,
                subscribers: issue.subscribers.nodes.map((sub) => ({
                    id: sub.id,
                    name: sub.name,
                })),
            },
        };
        return subscribeToIssueOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.unsubscribe_from_issue
// ════════════════════════════════════════════════════════════════════════════
const UNSUBSCRIBE_FROM_ISSUE_MUTATION = `
  mutation IssueUnsubscribe($issueId: String!, $userId: String) {
    issueUnsubscribe(id: $issueId, userId: $userId) {
      success
      issue {
        id
        identifier
      }
    }
  }
`;
const unsubscribeFromIssueInput = z.object({
    issueId: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Issue ID to unsubscribe from"),
    userId: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("User ID to unsubscribe (defaults to current user)"),
});
const unsubscribeFromIssueOutput = z.object({
    success: z.boolean(),
    issue: z.object({
        id: z.string(),
        identifier: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const unsubscribeFromIssue = {
    id: "linear.unsubscribe_from_issue",
    name: "Unsubscribe from Linear Issue",
    description: "Unsubscribe from issue notifications in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: unsubscribeFromIssueInput,
    output: unsubscribeFromIssueOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, UNSUBSCRIBE_FROM_ISSUE_MUTATION, { issueId: args.issueId, userId: args.userId });
        if (!response.issueUnsubscribe?.success || !response.issueUnsubscribe?.issue) {
            throw new Error("Failed to unsubscribe from issue");
        }
        const issue = response.issueUnsubscribe.issue;
        const baseData = {
            success: response.issueUnsubscribe.success,
            issue: {
                id: issue.id,
                identifier: issue.identifier,
            },
        };
        return unsubscribeFromIssueOutput.parse({
            ...baseData,
            estimatedTokens: estimateTokens(baseData),
        });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.create_favorite
// ════════════════════════════════════════════════════════════════════════════
const CREATE_FAVORITE_MUTATION = `
  mutation FavoriteCreate($input: FavoriteCreateInput!) {
    favoriteCreate(input: $input) {
      success
      favorite {
        id
        type
        issue {
          id
          identifier
        }
        project {
          id
          name
        }
      }
    }
  }
`;
const createFavoriteInput = z
    .object({
    issueId: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Issue UUID to favorite"),
    projectId: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Project UUID to favorite"),
})
    .refine((data) => (data.issueId || data.projectId) && !(data.issueId && data.projectId), "Must specify exactly one of: issueId or projectId");
const createFavoriteOutput = z.object({
    success: z.boolean(),
    favorite: z.object({
        id: z.string(),
        type: z.string(),
        issue: z
            .object({
            id: z.string(),
            identifier: z.string(),
        })
            .optional(),
        project: z
            .object({
            id: z.string(),
            name: z.string(),
        })
            .optional(),
    }),
    estimatedTokens: z.number(),
});
export const createFavorite = {
    id: "linear.create_favorite",
    name: "Create Linear Favorite",
    description: "Create a favorite (star) in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createFavoriteInput,
    output: createFavoriteOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const mutationInput = {};
        if (args.issueId)
            mutationInput.issueId = args.issueId;
        if (args.projectId)
            mutationInput.projectId = args.projectId;
        const response = await linearGraphQL(apiKey, CREATE_FAVORITE_MUTATION, {
            input: mutationInput,
        });
        if (!response.favoriteCreate?.success || !response.favoriteCreate?.favorite) {
            throw new Error("Failed to create favorite");
        }
        const favorite = response.favoriteCreate.favorite;
        const baseData = {
            success: response.favoriteCreate.success,
            favorite: {
                id: favorite.id,
                type: favorite.type,
                ...(favorite.issue && {
                    issue: {
                        id: favorite.issue.id,
                        identifier: favorite.issue.identifier,
                    },
                }),
                ...(favorite.project && {
                    project: {
                        id: favorite.project.id,
                        name: favorite.project.name,
                    },
                }),
            },
        };
        return createFavoriteOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.delete_favorite
// ════════════════════════════════════════════════════════════════════════════
const DELETE_FAVORITE_MUTATION = `
  mutation FavoriteDelete($id: String!) {
    favoriteDelete(id: $id) {
      success
    }
  }
`;
const deleteFavoriteInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Favorite UUID to delete"),
});
const deleteFavoriteOutput = z.object({
    success: z.boolean(),
    estimatedTokens: z.number(),
});
export const deleteFavorite = {
    id: "linear.delete_favorite",
    name: "Delete Linear Favorite",
    description: "Delete a favorite (unstar) in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: deleteFavoriteInput,
    output: deleteFavoriteOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, DELETE_FAVORITE_MUTATION, {
            id: args.id,
        });
        if (!response.favoriteDelete?.success) {
            throw new Error("Failed to delete favorite");
        }
        const baseData = {
            success: response.favoriteDelete.success,
        };
        return deleteFavoriteOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// Batch 7 — Initiatives family (create/get/list/update/delete/link_project).
// Shallow CRUD; NO resolvers (link_project_to_initiative passes raw initiativeId/
// projectId verbatim, matching the marketplace source). Appended below Batch 6;
// no existing export is modified.
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// linear.create_initiative
// ════════════════════════════════════════════════════════════════════════════
const CREATE_INITIATIVE_MUTATION = `
  mutation InitiativeCreate($input: InitiativeCreateInput!) {
    initiativeCreate(input: $input) {
      success
      initiative {
        id
        name
      }
    }
  }
`;
const createInitiativeInput = z.object({
    // Name is user content - required min(1); only block control chars (marketplace
    // used the strict validateNoControlChars, NOT the whitespace-allowing variant).
    // safeText returns ZodEffects (no .min()), so chain refines explicitly here.
    name: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .describe("Initiative name"),
    // Description is user content - allow whitespace, block dangerous control chars.
    description: z
        .string()
        .refine(noControlCharsAllowWhitespace, "Dangerous control characters not allowed")
        .optional()
        .describe("Initiative description (Markdown)"),
    // Date field - block control chars.
    targetDate: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("Target date (ISO format)"),
});
const createInitiativeOutput = z.object({
    success: z.boolean(),
    initiative: z.object({
        id: z.string(),
        name: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const createInitiative = {
    id: "linear.create_initiative",
    name: "Create Linear Initiative",
    description: "Create a new initiative in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createInitiativeInput,
    output: createInitiativeOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, CREATE_INITIATIVE_MUTATION, { input: args });
        if (!response.initiativeCreate.success) {
            throw new Error("Failed to create initiative");
        }
        const baseData = {
            success: true,
            initiative: {
                id: response.initiativeCreate.initiative.id,
                name: response.initiativeCreate.initiative.name,
            },
        };
        return createInitiativeOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.get_initiative
// ════════════════════════════════════════════════════════════════════════════
const GET_INITIATIVE_QUERY = `
  query Initiative($id: String!) {
    initiative(id: $id) {
      id
      name
      description
      targetDate
      createdAt
      updatedAt
    }
  }
`;
const getInitiativeInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Initiative ID or name"),
});
const getInitiativeOutput = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    targetDate: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    estimatedTokens: z.number(),
});
export const getInitiative = {
    id: "linear.get_initiative",
    name: "Get Linear Initiative",
    description: "Get detailed information about a specific Linear initiative",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: getInitiativeInput,
    output: getInitiativeOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, GET_INITIATIVE_QUERY, {
            id: args.id,
        });
        if (!response.initiative) {
            throw new Error(`Initiative not found: ${args.id}`);
        }
        const baseData = {
            id: response.initiative.id,
            name: response.initiative.name,
            description: response.initiative.description?.substring(0, 500),
            targetDate: response.initiative.targetDate || undefined,
            createdAt: response.initiative.createdAt || undefined,
            updatedAt: response.initiative.updatedAt || undefined,
        };
        return getInitiativeOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.list_initiatives
// ════════════════════════════════════════════════════════════════════════════
const LIST_INITIATIVES_QUERY = `
  query Initiatives($first: Int) {
    initiatives(first: $first) {
      nodes {
        id
        name
        description
        targetDate
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
const listInitiativesInput = z.object({
    filter: safeFilter("Filter by name or description (fuzzy search)"),
    limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of initiatives to return (default: 50, max: 100)"),
});
const listInitiativesOutput = z.object({
    initiatives: z.array(z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        targetDate: z.string().optional(),
    })),
    estimatedTokens: z.number(),
});
export const listInitiatives = {
    id: "linear.list_initiatives",
    name: "List Linear Initiatives",
    description: "List all initiatives in Linear with optional filtering",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listInitiativesInput,
    output: listInitiativesOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const variables = {};
        if (args.limit) {
            variables.first = args.limit;
        }
        const response = await linearGraphQL(apiKey, LIST_INITIATIVES_QUERY, variables);
        if (!response.initiatives || !Array.isArray(response.initiatives.nodes)) {
            throw new Error("Failed to list initiatives: Invalid response format");
        }
        const baseData = {
            initiatives: response.initiatives.nodes.map((init) => ({
                id: init.id,
                name: init.name,
                description: init.description?.substring(0, 200),
                targetDate: init.targetDate || undefined,
            })),
        };
        return listInitiativesOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.update_initiative
// ════════════════════════════════════════════════════════════════════════════
const UPDATE_INITIATIVE_MUTATION = `
  mutation InitiativeUpdate($id: String!, $input: InitiativeUpdateInput!) {
    initiativeUpdate(id: $id, input: $input) {
      success
      initiative {
        id
        name
      }
    }
  }
`;
const updateInitiativeInput = z.object({
    // ID is identifier - strict validation.
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Initiative ID or name"),
    // Name is user content - only block control chars.
    name: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("New initiative name"),
    // Description is user content - allow whitespace, block dangerous control chars.
    description: z
        .string()
        .refine(noControlCharsAllowWhitespace, "Dangerous control characters not allowed")
        .optional()
        .describe("New initiative description (Markdown)"),
    // Date field - block control chars.
    targetDate: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .optional()
        .describe("New target date (ISO format)"),
});
const updateInitiativeOutput = z.object({
    success: z.boolean(),
    initiative: z.object({
        id: z.string(),
        name: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const updateInitiative = {
    id: "linear.update_initiative",
    name: "Update Linear Initiative",
    description: "Update an existing initiative in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: updateInitiativeInput,
    output: updateInitiativeOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const { id, ...updateInput } = args;
        const response = await linearGraphQL(apiKey, UPDATE_INITIATIVE_MUTATION, { id, input: updateInput });
        if (!response.initiativeUpdate.success) {
            throw new Error("Failed to update initiative");
        }
        const baseData = {
            success: true,
            initiative: {
                id: response.initiativeUpdate.initiative.id,
                name: response.initiativeUpdate.initiative.name,
            },
        };
        return updateInitiativeOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.delete_initiative
// ════════════════════════════════════════════════════════════════════════════
const DELETE_INITIATIVE_MUTATION = `
  mutation InitiativeDelete($id: String!) {
    initiativeDelete(id: $id) {
      success
    }
  }
`;
const deleteInitiativeInput = z.object({
    id: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Initiative ID or name"),
});
const deleteInitiativeOutput = z.object({
    success: z.boolean(),
    estimatedTokens: z.number(),
});
export const deleteInitiative = {
    id: "linear.delete_initiative",
    name: "Delete Linear Initiative",
    description: "Delete an initiative in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: deleteInitiativeInput,
    output: deleteInitiativeOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, DELETE_INITIATIVE_MUTATION, { id: args.id });
        if (!response.initiativeDelete.success) {
            throw new Error("Failed to delete initiative");
        }
        const baseData = {
            success: true,
        };
        return deleteInitiativeOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.link_project_to_initiative
// ════════════════════════════════════════════════════════════════════════════
const LINK_PROJECT_TO_INITIATIVE_MUTATION = `
  mutation InitiativeToProjectCreate($initiativeId: String!, $projectId: String!) {
    initiativeToProjectCreate(initiativeId: $initiativeId, projectId: $projectId) {
      success
      initiativeToProject {
        id
      }
    }
  }
`;
const linkProjectToInitiativeInput = z.object({
    initiativeId: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Initiative ID or name"),
    projectId: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe("Project ID or name"),
});
const linkProjectToInitiativeOutput = z.object({
    success: z.boolean(),
    initiativeToProjectId: z.string(),
    estimatedTokens: z.number(),
});
export const linkProjectToInitiative = {
    id: "linear.link_project_to_initiative",
    name: "Link Project to Linear Initiative",
    description: "Link a project to an initiative in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: linkProjectToInitiativeInput,
    output: linkProjectToInitiativeOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, LINK_PROJECT_TO_INITIATIVE_MUTATION, {
            initiativeId: args.initiativeId,
            projectId: args.projectId,
        });
        if (!response.initiativeToProjectCreate.success) {
            throw new Error("Failed to link project to initiative");
        }
        if (!response.initiativeToProjectCreate.initiativeToProject) {
            throw new Error("Failed to link project to initiative: no link created");
        }
        const baseData = {
            success: true,
            initiativeToProjectId: response.initiativeToProjectCreate.initiativeToProject.id,
        };
        return linkProjectToInitiativeOutput.parse({
            ...baseData,
            estimatedTokens: estimateTokens(baseData),
        });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// Batch 8 — Documents (list/get/create/update) + Issue Relations
// (list/create/delete). Ported from the marketplace wrappers list-documents.ts,
// get-document.ts, create-document.ts, update-document.ts, list-issue-relations.ts,
// create-issue-relation.ts, delete-issue-relation.ts. Per §4, `id`/`name` are the
// marketplace `name:` string VERBATIM (INCONSISTENT casing is intentional and
// preserved): linear.documents / linear.get_document / linear.createDocument /
// linear.updateDocument / linear.list_issue_relations / linear.create_issue_relation /
// linear.delete_issue_relation. NONE call a resolver — raw IDs are passed straight to
// GraphQL exactly as the source did. Adapter rules per Batch 1: testToken dropped,
// signature (args, ctx), CTX-only ctx.secrets.LINEAR_API_KEY, HTTP via linearGraphQL,
// no .default() on input (applied in handler), validator choices mirror each source.
// ════════════════════════════════════════════════════════════════════════════
// ── strict-ID field (mirrors marketplace 3-refine validator for IDs/filters) ──
/** A strict reference/ID field: rejects control chars, path traversal, injection. */
function safeStrictId(describe) {
    return z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .describe(describe);
}
// ════════════════════════════════════════════════════════════════════════════
// linear.documents  (marketplace name: "linear.documents" — NOT list_documents)
// ════════════════════════════════════════════════════════════════════════════
const LIST_DOCUMENTS_QUERY = `
  query Documents($first: Int!, $filter: DocumentFilter) {
    documents(first: $first, filter: $filter) {
      nodes {
        id
        title
        content
        slugId
        url
        createdAt
        updatedAt
      }
    }
  }
`;
const listDocumentsInput = z.object({
    project: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Project ID to filter by"),
    initiative: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Initiative ID to filter by"),
    // NOTE: marketplace had `.default(50)`; gateway forbids `.default()` on input — applied in handler.
    limit: z.number().min(1).max(250).optional().describe("Number of results (max 250)"),
});
const DEFAULT_DOCUMENTS_LIMIT = 50;
const listDocumentsOutput = z.object({
    documents: z.array(z.object({
        id: z.string(),
        title: z.string(),
        content: z.string().optional(),
        slugId: z.string().optional(),
        url: z.string().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
    })),
    totalDocuments: z.number(),
    estimatedTokens: z.number(),
});
export const listDocuments = {
    id: "linear.documents",
    name: "List Linear Documents",
    description: "List documents from Linear with optional filters",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listDocumentsInput,
    output: listDocumentsOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const filter = {};
        if (args.project) {
            filter.project = { id: { eq: args.project } };
        }
        if (args.initiative) {
            filter.initiative = { id: { eq: args.initiative } };
        }
        const response = await linearGraphQL(apiKey, LIST_DOCUMENTS_QUERY, {
            first: args.limit ?? DEFAULT_DOCUMENTS_LIMIT,
            ...(Object.keys(filter).length > 0 ? { filter } : {}),
        });
        const transformedDocuments = response.documents.nodes.map((doc) => ({
            id: doc.id,
            title: doc.title,
            content: doc.content != null ? doc.content.substring(0, 200) : undefined,
            slugId: doc.slugId || undefined,
            url: doc.url,
            createdAt: doc.createdAt ?? undefined,
            updatedAt: doc.updatedAt ?? undefined,
        }));
        const baseData = {
            documents: transformedDocuments,
            totalDocuments: transformedDocuments.length,
        };
        return listDocumentsOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.get_document
// ════════════════════════════════════════════════════════════════════════════
const GET_DOCUMENT_QUERY = `
  query Document($id: String!) {
    document(id: $id) {
      id
      title
      content
      slugId
      url
      createdAt
      updatedAt
    }
  }
`;
const getDocumentInput = z.object({
    id: safeStrictId("Document ID or slug (e.g., doc-uuid-123 or security-review)"),
});
const getDocumentOutput = z.object({
    id: z.string(),
    title: z.string(),
    content: z.string().optional(),
    slugId: z.string().optional(),
    url: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    estimatedTokens: z.number(),
});
export const getDocument = {
    id: "linear.get_document",
    name: "Get Linear Document",
    description: "Get detailed information about a specific Linear document",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: getDocumentInput,
    output: getDocumentOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, GET_DOCUMENT_QUERY, {
            id: args.id,
        });
        if (!response.document) {
            throw new Error(`Document not found: ${args.id}`);
        }
        const baseData = {
            id: response.document.id,
            title: response.document.title,
            content: response.document.content?.substring(0, 1000),
            slugId: response.document.slugId || undefined,
            url: response.document.url,
            createdAt: response.document.createdAt,
            updatedAt: response.document.updatedAt,
        };
        return getDocumentOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.createDocument  (marketplace name: "linear.createDocument" — camelCase)
// ════════════════════════════════════════════════════════════════════════════
const CREATE_DOCUMENT_MUTATION = `
  mutation DocumentCreate($title: String!, $content: String!, $projectId: String, $initiativeId: String) {
    documentCreate(input: {
      title: $title
      content: $content
      projectId: $projectId
      initiativeId: $initiativeId
    }) {
      success
      document {
        id
        title
        slugId
        url
        createdAt
        updatedAt
      }
    }
  }
`;
const createDocumentInput = z.object({
    // Title: block control chars + path traversal, but NO command-injection check (matches source).
    title: z
        .string()
        .min(1)
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .describe("Document title"),
    // Content is Markdown — allow whitespace control chars (tabs, newlines).
    content: z
        .string()
        .min(1)
        .refine(noControlCharsAllowWhitespace, "Dangerous control characters not allowed")
        .describe("Document content (Markdown)"),
    project: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Project ID to link document to"),
    initiative: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected")
        .optional()
        .describe("Initiative ID to link document to"),
});
const createDocumentOutput = z.object({
    success: z.boolean(),
    document: z.object({
        id: z.string(),
        title: z.string(),
        slugId: z.string().optional(),
        url: z.string(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
    }),
    estimatedTokens: z.number(),
});
export const createDocument = {
    id: "linear.createDocument",
    name: "Create Linear Document",
    description: "Create a new document in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createDocumentInput,
    output: createDocumentOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, CREATE_DOCUMENT_MUTATION, {
            title: args.title,
            content: args.content,
            projectId: args.project,
            initiativeId: args.initiative,
        });
        if (!response.documentCreate.success) {
            throw new Error("Failed to create document: Linear API returned success: false");
        }
        if (!response.documentCreate.document.id) {
            throw new Error("Failed to create document: No document ID returned");
        }
        const baseData = {
            success: true,
            document: {
                id: response.documentCreate.document.id,
                title: response.documentCreate.document.title,
                slugId: response.documentCreate.document.slugId || undefined,
                url: response.documentCreate.document.url,
                createdAt: response.documentCreate.document.createdAt || undefined,
                updatedAt: response.documentCreate.document.updatedAt || undefined,
            },
        };
        return createDocumentOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.updateDocument  (marketplace name: "linear.updateDocument" — camelCase)
// ════════════════════════════════════════════════════════════════════════════
const UPDATE_DOCUMENT_MUTATION = `
  mutation UpdateDocument($id: String!, $title: String, $content: String) {
    documentUpdate(id: $id, input: { title: $title, content: $content }) {
      success
      document {
        id
        title
        slugId
        url
        updatedAt
      }
    }
  }
`;
const updateDocumentInput = z.object({
    id: safeStrictId("Document ID or slug"),
    // Title: block control chars + path traversal, NO command-injection check (matches source).
    title: z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .optional()
        .describe("New title"),
    // Content is Markdown — allow whitespace control chars (tabs, newlines).
    content: z
        .string()
        .refine(noControlCharsAllowWhitespace, "Dangerous control characters not allowed")
        .optional()
        .describe("New content (Markdown)"),
});
const updateDocumentOutput = z.object({
    success: z.boolean(),
    document: z.object({
        id: z.string(),
        title: z.string(),
        slugId: z.string().optional(),
        url: z.string(),
        updatedAt: z.string().optional(),
    }),
    estimatedTokens: z.number(),
});
export const updateDocument = {
    id: "linear.updateDocument",
    name: "Update Linear Document",
    description: "Update an existing document in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: updateDocumentInput,
    output: updateDocumentOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, UPDATE_DOCUMENT_MUTATION, {
            id: args.id,
            title: args.title,
            content: args.content,
        });
        if (!response.documentUpdate.success || !response.documentUpdate.document) {
            throw new Error(`Failed to update document: ${args.id}`);
        }
        const baseData = {
            success: response.documentUpdate.success,
            document: {
                id: response.documentUpdate.document.id,
                title: response.documentUpdate.document.title,
                slugId: response.documentUpdate.document.slugId || undefined,
                url: response.documentUpdate.document.url,
                updatedAt: response.documentUpdate.document.updatedAt || undefined,
            },
        };
        return updateDocumentOutput.parse({ ...baseData, estimatedTokens: estimateTokens(baseData) });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.list_issue_relations
// ════════════════════════════════════════════════════════════════════════════
const LIST_ISSUE_RELATIONS_QUERY = `
  query IssueRelations($issueId: String!) {
    issue(id: $issueId) {
      relations {
        nodes {
          id
          type
          relatedIssue {
            id
            identifier
            title
          }
        }
      }
    }
  }
`;
const listIssueRelationsInput = z.object({
    issueId: safeStrictId('Issue identifier (e.g., "ISSUE-123" or UUID)'),
});
const listIssueRelationsOutput = z.object({
    relations: z.array(z.object({
        id: z.string(),
        type: z.string(),
        relatedIssue: z.object({
            id: z.string(),
            identifier: z.string(),
            title: z.string(),
        }),
    })),
    estimatedTokens: z.number(),
});
export const listIssueRelations = {
    id: "linear.list_issue_relations",
    name: "List Linear Issue Relations",
    description: "List all relations for an issue in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: listIssueRelationsInput,
    output: listIssueRelationsOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, LIST_ISSUE_RELATIONS_QUERY, { issueId: args.issueId });
        if (!response.issue?.relations?.nodes) {
            throw new Error("Failed to list issue relations: Invalid response format");
        }
        const baseData = {
            relations: response.issue.relations.nodes.map((relation) => ({
                id: relation.id,
                type: relation.type,
                relatedIssue: {
                    id: relation.relatedIssue.id,
                    identifier: relation.relatedIssue.identifier,
                    title: relation.relatedIssue.title,
                },
            })),
        };
        return listIssueRelationsOutput.parse({
            ...baseData,
            estimatedTokens: estimateTokens(baseData),
        });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.create_issue_relation  (raw issueId/relatedIssueId — NO resolver, per source)
// ════════════════════════════════════════════════════════════════════════════
const CREATE_ISSUE_RELATION_MUTATION = `
  mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation {
        id
        type
        issue { id }
        relatedIssue { id }
      }
    }
  }
`;
const createIssueRelationInput = z.object({
    issueId: safeStrictId('Issue identifier (e.g., "ISSUE-123" or UUID)'),
    relatedIssueId: safeStrictId("Related issue identifier"),
    type: z
        .enum(["blocks", "blocked_by", "duplicate", "related"])
        .describe("Relation type: blocks, blocked_by, duplicate, or related"),
});
const createIssueRelationOutput = z.object({
    success: z.boolean(),
    relation: z.object({
        id: z.string(),
        type: z.string(),
        issueId: z.string(),
        relatedIssueId: z.string(),
    }),
    estimatedTokens: z.number(),
});
export const createIssueRelation = {
    id: "linear.create_issue_relation",
    name: "Create Linear Issue Relation",
    description: "Create a relation between two issues in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: createIssueRelationInput,
    output: createIssueRelationOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        // Raw IDs passed straight through (matches marketplace: { input: validated } with no resolver).
        const response = await linearGraphQL(apiKey, CREATE_ISSUE_RELATION_MUTATION, { input: { issueId: args.issueId, relatedIssueId: args.relatedIssueId, type: args.type } });
        if (!response.issueRelationCreate.success) {
            throw new Error("Failed to create issue relation");
        }
        if (!response.issueRelationCreate.issueRelation) {
            throw new Error("Failed to create issue relation: No relation returned");
        }
        const baseData = {
            success: response.issueRelationCreate.success,
            relation: {
                id: response.issueRelationCreate.issueRelation.id,
                type: response.issueRelationCreate.issueRelation.type,
                issueId: response.issueRelationCreate.issueRelation.issue.id,
                relatedIssueId: response.issueRelationCreate.issueRelation.relatedIssue.id,
            },
        };
        return createIssueRelationOutput.parse({
            ...baseData,
            estimatedTokens: estimateTokens(baseData),
        });
    },
};
// ════════════════════════════════════════════════════════════════════════════
// linear.delete_issue_relation
// ════════════════════════════════════════════════════════════════════════════
const DELETE_ISSUE_RELATION_MUTATION = `
  mutation IssueRelationDelete($id: String!) {
    issueRelationDelete(id: $id) {
      success
    }
  }
`;
const deleteIssueRelationInput = z.object({
    relationId: safeStrictId("Relation UUID to delete"),
});
const deleteIssueRelationOutput = z.object({
    success: z.boolean(),
    estimatedTokens: z.number(),
});
export const deleteIssueRelation = {
    id: "linear.delete_issue_relation",
    name: "Delete Linear Issue Relation",
    description: "Delete a relation between issues in Linear",
    auth: ["LINEAR_API_KEY"],
    wraps: { type: "rest" },
    input: deleteIssueRelationInput,
    output: deleteIssueRelationOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.LINEAR_API_KEY;
        const response = await linearGraphQL(apiKey, DELETE_ISSUE_RELATION_MUTATION, { id: args.relationId });
        if (!response.issueRelationDelete.success) {
            throw new Error("Failed to delete issue relation");
        }
        const baseData = { success: true };
        return deleteIssueRelationOutput.parse({
            ...baseData,
            estimatedTokens: estimateTokens(baseData),
        });
    },
};
