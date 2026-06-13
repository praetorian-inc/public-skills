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

/**
 * The gateway's `ToolDescriptor` contract, declared LOCALLY (structurally) so
 * this wrapper has ZERO compile-time or runtime dependency on gateway source —
 * it is a fully portable unit (imports only `zod`). The gateway resolves and
 * validates tools structurally (runner.ts / drift.ts use duck-typed checks, not
 * `instanceof ToolDescriptor`), so a structural match is exactly equivalent to
 * importing the type. Mirrors `gateway/src/execute/descriptor.ts:15-36`.
 */
interface ExecContext {
  secrets: Record<string, string>;
}
interface ToolDescriptor<I, O> {
  id: string;
  name: string;
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  auth?: string[];
  wraps?: { type: "mcp" | "rest"; server?: string; tool?: string };
  handler: (args: I, ctx: ExecContext) => Promise<O>;
}

// ── Inlined sanitizers (keep this wrapper a self-contained portable unit) ─────

const PATH_TRAVERSAL = [/\.\.\//, /\.\.\\/, /\.\.$/, /^\.\.$/, /~\//];
const COMMAND_INJECTION = [/[;&|`$]/, /\$\(/, /`[^`]*`/, /\|\|/, /&&/, />\s*\/|>>/, /<\s*\//];
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]");

const noPathTraversal = (s: string): boolean => !PATH_TRAVERSAL.some((p) => p.test(s));
const noCommandInjection = (s: string): boolean => !COMMAND_INJECTION.some((p) => p.test(s));
const noControlChars = (s: string): boolean => !CONTROL_CHARS.test(s);

/** ~4 chars per token over the JSON encoding (mirrors the marketplace estimate). */
function estimateTokens(data: unknown): number {
  const json = typeof data === "string" ? data : JSON.stringify(data);
  return Math.ceil(json.length / 4);
}

/** A safe-string filter field: rejects control chars, path traversal, injection. */
function safeFilter(describe: string) {
  return z
    .string()
    .refine(noControlChars, "Control characters not allowed")
    .refine(noPathTraversal, "Path traversal not allowed")
    .refine(noCommandInjection, "Invalid characters detected")
    .optional()
    .describe(describe);
}

// ── Transport-injection seam (tests inject a fake fetch; default = global) ────

/** The subset of the `fetch` signature this wrapper uses. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let activeFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/** TEST-ONLY: override the transport so no real HTTP happens in unit tests. */
export function __setFetch(fn: FetchLike): void {
  activeFetch = fn;
}

/** TEST-ONLY: restore the default global `fetch`. */
export function __resetFetch(): void {
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
  issues: z.array(
    z.object({
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
    }),
  ),
  totalIssues: z.number(),
  nextOffset: z.string().optional(),
  estimatedTokens: z.number(),
});

type ListIssuesInput = z.infer<typeof input>;
type ListIssuesOutput = z.infer<typeof output>;

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

interface IssueNode {
  id: string;
  identifier?: string | null;
  title: string;
  description?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  state?: { id: string; name: string; type: string } | null;
  assignee?: { id: string; name: string } | null;
  creator?: { id: string; name: string } | null;
  url?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  cycle?: { id: string; name: string } | null;
  parent?: { id: string; identifier: string } | null;
  dueDate?: string | null;
}

interface IssuesListData {
  issues: {
    nodes: IssueNode[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  } | null;
}

interface GraphQLEnvelope<T> {
  data?: T | null;
  errors?: Array<{ message: string }>;
}

/**
 * Build a Linear `IssueFilter` from the validated input. Only string filters the
 * tool supports are mapped; UUID-vs-name disambiguation from the marketplace
 * wrapper is intentionally NOT ported (the spike's scope is the adapter, not
 * filter fidelity) — name filters are used, matching Linear's `IssueFilter`.
 */
function buildFilter(args: ListIssuesInput): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (args.team) filter.team = { name: { eq: args.team } };
  if (args.assignee) filter.assignee = { name: { eq: args.assignee } };
  if (args.creator) filter.creator = { name: { eq: args.creator } };
  if (args.state) filter.state = { name: { eq: args.state } };
  if (args.project) filter.project = { name: { eq: args.project } };
  if (args.label) filter.labels = { name: { eq: args.label } };
  if (args.parent) filter.parent = { id: { eq: args.parent } };
  if (args.query) filter.searchableContent = { contains: args.query };
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
export const listIssues: ToolDescriptor<ListIssuesInput, ListIssuesOutput> = {
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

    const envelope = (await res.json()) as GraphQLEnvelope<IssuesListData>;
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

// ════════════════════════════════════════════════════════════════════════════
// Batch 1 — Shared scaffold (linearGraphQL + resolvers + safeText) and the
// Issues family (get/create/update/find/archive/unarchive). Appended below the
// reviewed-GO `listIssues` block; `listIssues` is left byte-identical.
// ════════════════════════════════════════════════════════════════════════════

// ── 1.1 Shared GraphQL transport (mirrors marketplace parseGraphQLResponse) ───

/** Minimal GraphQL envelope (mirrors marketplace GraphQLResponse). */
interface GqlEnvelope<T> {
  data?: T | null;
  errors?: Array<{ message: string; path?: string[]; extensions?: Record<string, unknown> }>;
}

/**
 * Execute a Linear GraphQL request via the injectable `activeFetch` transport.
 * CTX-only: the caller passes `apiKey` (from `ctx.secrets.LINEAR_API_KEY`); it is sent in the
 * `Authorization` header with NO "Bearer " prefix. Throws on HTTP !ok, on a non-empty
 * `errors[]`, and on null/undefined `data` — mirroring marketplace `parseGraphQLResponse`.
 */
async function linearGraphQL<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await activeFetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API HTTP ${res.status}`);
  }
  const env = (await res.json()) as GqlEnvelope<T>;
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
const noControlCharsAllowWhitespace = (s: string): boolean => !CONTROL_CHARS_NO_WS.test(s);

/**
 * A free-text field (title/description/body): allows whitespace, rejects other control chars,
 * path traversal, and command injection. Use for human-prose fields, NOT for IDs/filters.
 */
function safeText(describe: string) {
  return z
    .string()
    .refine(noControlCharsAllowWhitespace, "Control characters not allowed")
    .refine(noPathTraversal, "Path traversal not allowed")
    .refine(noCommandInjection, "Invalid characters detected")
    .describe(describe);
}

// ── 1.2 isUUID + ID resolvers (inlined from lib/resolve-ids.ts; apiKey-taking) ─

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(s: string): boolean {
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

interface WorkflowStatesResponse {
  workflowStates: {
    nodes: Array<{ id: string; name: string; type: string }>;
  };
}

interface ViewerResponse {
  viewer: { id: string };
}

interface UsersResponse {
  users: {
    nodes: Array<{
      id: string;
      name: string;
      email: string;
      displayName?: string | null;
      avatarUrl?: string | null;
      active?: boolean | null;
      admin?: boolean | null;
      createdAt?: string | null;
    }>;
  };
}

interface ProjectsForResolutionResponse {
  projects: {
    nodes: Array<{ id: string; name: string }>;
  };
}

interface TeamsResponse {
  teams: {
    nodes: Array<{ id: string; name: string; key?: string | null }>;
  };
}

interface IssueResolveResponse {
  issue: { id: string };
}

/** Resolve team name to team UUID (UUID pass-through; else match by name, case-insensitive). */
async function resolveTeamId(apiKey: string, teamNameOrId: string): Promise<string> {
  if (isUUID(teamNameOrId)) {
    return teamNameOrId;
  }

  const response = await linearGraphQL<TeamsResponse>(apiKey, TEAMS_QUERY, {});
  const teams = response.teams?.nodes || [];

  const team = teams.find((t) => t.name.toLowerCase() === teamNameOrId.toLowerCase());

  if (!team) {
    const availableTeams = teams.map((t) => t.name).join(", ");
    throw new Error(
      `Team not found: ${teamNameOrId}\n\n` +
        `Available teams: ${availableTeams || "(none)"}\n\n` +
        `Tip: Team names are case-insensitive but must match exactly.`,
    );
  }

  return team.id;
}

/** Resolve state name/type to state UUID (UUID pass-through; else match name or type). */
async function resolveStateId(apiKey: string, teamId: string, stateNameOrId: string): Promise<string> {
  if (isUUID(stateNameOrId)) {
    return stateNameOrId;
  }

  const response = await linearGraphQL<WorkflowStatesResponse>(apiKey, WORKFLOW_STATES_QUERY, {
    teamId,
  });

  const state = response.workflowStates.nodes.find(
    (s) =>
      s.name.toLowerCase() === stateNameOrId.toLowerCase() ||
      s.type.toLowerCase() === stateNameOrId.toLowerCase(),
  );

  if (!state) {
    throw new Error(`State not found: ${stateNameOrId}`);
  }

  return state.id;
}

/** Resolve assignee ("me"/email/name) to user UUID (UUID pass-through). */
async function resolveAssigneeId(apiKey: string, assigneeNameOrId: string): Promise<string> {
  if (assigneeNameOrId.toLowerCase() === "me") {
    const viewer = await linearGraphQL<ViewerResponse>(apiKey, VIEWER_QUERY, {});
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

  const response = await linearGraphQL<UsersResponse>(apiKey, FIND_USER_QUERY, {
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
async function resolveParentId(apiKey: string, parentIdentifierOrId: string): Promise<string> {
  if (isUUID(parentIdentifierOrId)) {
    return parentIdentifierOrId;
  }

  const response = await linearGraphQL<IssueResolveResponse>(apiKey, ISSUE_RESOLVE_QUERY, {
    id: parentIdentifierOrId,
  });

  if (!response.issue?.id) {
    throw new Error(`Parent issue not found: ${parentIdentifierOrId}`);
  }

  return response.issue.id;
}

/** Resolve project name to project UUID (UUID pass-through; else match name, case-insensitive). */
async function resolveProjectId(apiKey: string, projectNameOrId: string): Promise<string> {
  if (isUUID(projectNameOrId)) {
    return projectNameOrId;
  }

  const response = await linearGraphQL<ProjectsForResolutionResponse>(
    apiKey,
    PROJECTS_FOR_RESOLUTION_QUERY,
    {},
  );

  const project = response.projects.nodes.find(
    (p) => p.name.toLowerCase() === projectNameOrId.toLowerCase(),
  );

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

interface TemplatesWithDataResponse {
  templates?: Array<{
    id: string;
    name: string;
    type?: string | null;
    templateData?: unknown;
  }> | null;
}

interface ParsedTemplateData {
  projectId?: string;
  teamId?: string;
  [key: string]: unknown;
}

/** Parse templateData field which can be a JSON string or an object. */
function parseTemplateData(raw: unknown): ParsedTemplateData | null {
  if (!raw) return null;

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ParsedTemplateData;
    } catch {
      return null;
    }
  }

  if (typeof raw === "object") {
    return raw as ParsedTemplateData;
  }

  return null;
}

/** Find the issue template associated with a project (returns template id or undefined). */
async function resolveTemplateForProject(
  apiKey: string,
  projectId: string,
): Promise<string | undefined> {
  const response = await linearGraphQL<TemplatesWithDataResponse>(
    apiKey,
    TEMPLATES_WITH_DATA_QUERY,
    {},
  );

  const templates = response.templates || [];

  for (const template of templates) {
    if (template.type !== "issue") continue;

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

type GetIssueInput = z.infer<typeof getIssueInput>;
type GetIssueOutput = z.infer<typeof getIssueOutput>;

interface IssueResponse {
  issue: {
    id: string;
    identifier: string;
    title: string;
    description?: string | null;
    priority?: number | null;
    priorityLabel?: string | null;
    estimate?: number | null;
    state?: { id: string; name: string; type: string } | null;
    assignee?: { id: string; name: string; email: string } | null;
    project?: { id: string; name: string } | null;
    cycle?: { id: string; name: string } | null;
    parent?: { id: string; identifier: string } | null;
    dueDate?: string | null;
    url?: string;
    branchName?: string;
    createdAt?: string;
    updatedAt?: string;
    attachments?: { nodes: Array<{ id: string; title: string; url: string }> };
  } | null;
}

export const getIssue: ToolDescriptor<GetIssueInput, GetIssueOutput> = {
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

    const response = await linearGraphQL<IssueResponse>(apiKey, GET_ISSUE_QUERY, { id: args.id });

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
      state:
        issue.state && issue.state.id
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
    .array(
      z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noCommandInjection, "Invalid characters detected"),
    )
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

type UpdateIssueInput = z.infer<typeof updateIssueInput>;
type UpdateIssueOutput = z.infer<typeof updateIssueOutput>;

interface IssueTeamResponse {
  issue: { team: { id: string } };
}

interface IssueUpdateResponse {
  issueUpdate: {
    success: boolean;
    issue?: {
      id: string;
      identifier: string;
      title: string;
      url: string;
      project?: { id: string; name: string } | null;
    };
  };
}

export const updateIssue: ToolDescriptor<UpdateIssueInput, UpdateIssueOutput> = {
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
    let teamId: string | undefined;
    if (updateFields.state) {
      const teamResponse = await linearGraphQL<IssueTeamResponse>(apiKey, GET_ISSUE_TEAM_QUERY, {
        id,
      });
      teamId = teamResponse.issue.team.id;
    }

    const mutationInput: {
      title?: string;
      description?: string;
      assigneeId?: string;
      stateId?: string;
      priority?: number;
      projectId?: string | null;
      labelIds?: string[];
      dueDate?: string;
      parentId?: string;
      cycleId?: string;
    } = {};

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
      } else {
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
    } else if (updateFields.parentId) {
      mutationInput.parentId = updateFields.parentId;
    }
    if (updateFields.cycle) {
      mutationInput.cycleId = updateFields.cycle;
    }

    const response = await linearGraphQL<IssueUpdateResponse>(apiKey, UPDATE_ISSUE_MUTATION, {
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
    .array(
      z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noCommandInjection, "Invalid characters detected"),
    )
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

type CreateIssueInput = z.infer<typeof createIssueInput>;
type CreateIssueOutput = z.infer<typeof createIssueOutput>;

interface IssueCreateResponse {
  issueCreate: {
    success: boolean;
    issue?: {
      id: string;
      identifier: string;
      title: string;
      url: string;
    };
  };
}

export const createIssue: ToolDescriptor<CreateIssueInput, CreateIssueOutput> = {
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
    let resolvedTemplateId: string | undefined = templateId;

    if (autoApplyProjectTemplate && createParams.project && !resolvedTemplateId) {
      try {
        const projectId = await resolveProjectId(apiKey, createParams.project);
        resolvedTemplateId = await resolveTemplateForProject(apiKey, projectId);
        // Silent fallback: if no template found, proceed without one.
      } catch (error) {
        // Template lookup failed, proceed without template (do not abort the create).
        console.warn(
          `Template lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Resolve team name to UUID before building mutation input.
    const teamId = await resolveTeamId(apiKey, createParams.team);

    const mutationInput: {
      title: string;
      description?: string;
      teamId: string;
      assigneeId?: string;
      stateId?: string;
      priority?: number;
      projectId?: string;
      labelIds?: string[];
      dueDate?: string;
      parentId?: string;
      templateId?: string;
    } = {
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
    } else if (createParams.parentId) {
      mutationInput.parentId = createParams.parentId;
    }
    if (resolvedTemplateId) {
      mutationInput.templateId = resolvedTemplateId;
    }

    const response = await linearGraphQL<IssueCreateResponse>(apiKey, CREATE_ISSUE_MUTATION, {
      input: mutationInput,
    });

    if (!response.issueCreate?.success) {
      throw new Error(
        "Failed to create issue. Check that:\n" +
          "- Team exists and you have access\n" +
          "- All required fields are provided (title, team)\n" +
          "- Optional fields (assignee, state, project) reference valid entities",
      );
    }

    if (!response.issueCreate?.issue) {
      throw new Error("Failed to create issue: No issue returned from API");
    }

    // If cycle was provided, update the issue to assign it (Linear can't set cycle on create).
    // Internal call to updateIssue.handler with the SAME ctx — NOT a dynamic import.
    if (cycle) {
      try {
        await updateIssue.handler({ id: response.issueCreate.issue.identifier, cycle }, ctx);
      } catch (error) {
        // Issue created successfully but cycle assignment failed: warn, don't fail the operation.
        console.warn(
          `Warning: Issue created but cycle assignment failed: ${error instanceof Error ? error.message : String(error)}`,
        );
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

interface SearchIssuesResponse {
  issues: {
    nodes: Array<{
      id: string;
      identifier: string;
      title: string;
      state?: { id: string; name: string; type: string } | null;
      assignee?: { name: string } | null;
      url?: string;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
}

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

type FindIssueInput = z.infer<typeof findIssueInput>;
type FindIssueOutput = z.infer<typeof findIssueOutput>;
type IssueCandidate = z.infer<typeof issueCandidateSchema>;

const FIND_ISSUE_DEFAULT_MAX_RESULTS = 5;

/** Check if input looks like an issue identifier (ABC-123, number-only, or UUID). */
function looksLikeIdentifier(input: string): boolean {
  if (/^[A-Z]+-\d+$/i.test(input)) return true;
  if (/^\d+$/.test(input)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) return true;
  return false;
}

/** Check if input is number-only (not a full identifier or UUID). */
function isNumberOnly(input: string): boolean {
  return /^\d+$/.test(input);
}

/** Check if an error is critical and should propagate (rate limit / server / timeout). */
function isCriticalError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("rate limit") ||
      msg.includes("server") ||
      msg.includes("etimedout") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset")
    );
  }
  return false;
}

/** Try to get an issue by exact ID/identifier via getIssue.handler; null on (non-critical) miss. */
async function tryExactMatch(
  id: string,
  ctx: ExecContext,
  propagateErrors = false,
): Promise<GetIssueOutput | null> {
  try {
    return await getIssue.handler({ id }, ctx);
  } catch (error) {
    if (propagateErrors && isCriticalError(error)) {
      throw error;
    }
    return null;
  }
}

/** Search for issues matching the query (title/description contains). */
async function searchIssues(
  apiKey: string,
  query: string,
  team?: string,
  limit = FIND_ISSUE_DEFAULT_MAX_RESULTS,
): Promise<IssueCandidate[]> {
  try {
    const filter: Record<string, unknown> = {
      or: [{ title: { contains: query } }, { description: { contains: query } }],
    };

    if (team) {
      filter.team = { name: { eq: team } };
    }

    const response = await linearGraphQL<SearchIssuesResponse>(apiKey, SEARCH_ISSUES_QUERY, {
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
  } catch {
    return [];
  }
}

/** Search for issues whose identifier number contains the supplied number. */
async function searchByNumber(
  apiKey: string,
  numberStr: string,
  team?: string,
  limit = FIND_ISSUE_DEFAULT_MAX_RESULTS,
): Promise<IssueCandidate[]> {
  try {
    const filter: Record<string, unknown> = {};

    if (team) {
      filter.team = { name: { eq: team } };
    }

    const response = await linearGraphQL<SearchIssuesResponse>(apiKey, SEARCH_ISSUES_QUERY, {
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
  } catch {
    return [];
  }
}

export const findIssue: ToolDescriptor<FindIssueInput, FindIssueOutput> = {
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
        } else if (numberMatches.length > 1) {
          return {
            status: "disambiguation_needed",
            message: `Found ${numberMatches.length} issues matching "${query}"`,
            query,
            candidates: numberMatches,
            hint: `Please specify the full identifier (e.g., "${numberMatches[0].identifier}")`,
          };
        }
      } else {
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

type ArchiveIssueInput = z.infer<typeof archiveIssueInput>;
type ArchiveIssueOutput = z.infer<typeof archiveIssueOutput>;

interface IssueArchiveResponse {
  issueArchive: {
    success: boolean;
    entity?: { id: string; identifier: string; archivedAt: string };
  };
}

export const archiveIssue: ToolDescriptor<ArchiveIssueInput, ArchiveIssueOutput> = {
  id: "linear.archive_issue",
  name: "Archive Linear Issue",
  description: "Archive an issue in Linear",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: archiveIssueInput,
  output: archiveIssueOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<IssueArchiveResponse>(apiKey, ARCHIVE_ISSUE_MUTATION, {
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

type UnarchiveIssueInput = z.infer<typeof unarchiveIssueInput>;
type UnarchiveIssueOutput = z.infer<typeof unarchiveIssueOutput>;

interface IssueUnarchiveResponse {
  issueUnarchive: {
    success: boolean;
    entity?: { id: string; identifier: string; archivedAt: string | null };
  };
}

export const unarchiveIssue: ToolDescriptor<UnarchiveIssueInput, UnarchiveIssueOutput> = {
  id: "linear.unarchive_issue",
  name: "Unarchive Linear Issue",
  description: "Unarchive an issue in Linear",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: unarchiveIssueInput,
  output: unarchiveIssueOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<IssueUnarchiveResponse>(apiKey, UNARCHIVE_ISSUE_MUTATION, {
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
  projects: z.array(
    z.object({
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
    }),
  ),
  totalProjects: z.number(),
  nextOffset: z.string().optional(),
  estimatedTokens: z.number(),
});

type ListProjectsInput = z.infer<typeof listProjectsInput>;
type ListProjectsOutput = z.infer<typeof listProjectsOutput>;

interface ProjectsListResponse {
  projects: {
    nodes: Array<{
      id: string;
      name: string;
      description?: string | null;
      content?: string | null;
      state?: string | null;
      lead?: { id: string; name: string } | null;
      startDate?: string | null;
      targetDate?: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  };
}

export const listProjects: ToolDescriptor<ListProjectsInput, ListProjectsOutput> = {
  id: "linear.list_projects",
  name: "List Linear Projects",
  description: "List projects from Linear workspace",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: listProjectsInput,
  output: listProjectsOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<ProjectsListResponse>(apiKey, LIST_PROJECTS_QUERY, {
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

type GetProjectInput = z.infer<typeof getProjectInput>;
type GetProjectOutput = z.infer<typeof getProjectOutput>;

interface ProjectResponse {
  project: {
    id: string;
    name: string;
    description?: string | null;
    content?: string | null;
    state?: string | null;
    lead?: { id: string; name: string; email: string } | null;
    startDate?: string | null;
    targetDate?: string | null;
    createdAt?: string;
    updatedAt?: string;
  } | null;
}

export const getProject: ToolDescriptor<GetProjectInput, GetProjectOutput> = {
  id: "linear.get_project",
  name: "Get Linear Project",
  description: "Get detailed information about a specific Linear project",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: getProjectInput,
  output: getProjectOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<ProjectResponse>(apiKey, GET_PROJECT_QUERY, {
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
    .array(
      z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected"),
    )
    .optional()
    .describe("Label names or IDs"),
});

const createProjectOutput = z.object({
  success: z.boolean(),
  project: z.object({ id: z.string(), name: z.string(), url: z.string() }),
  estimatedTokens: z.number(),
});

type CreateProjectInput = z.infer<typeof createProjectInput>;
type CreateProjectOutput = z.infer<typeof createProjectOutput>;

interface ProjectCreateResponse {
  projectCreate: {
    success: boolean;
    project?: { id: string; name: string; url: string };
  };
}

export const createProject: ToolDescriptor<CreateProjectInput, CreateProjectOutput> = {
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

    const mutationInput: {
      name: string;
      description?: string;
      summary?: string;
      teamIds: string[];
      leadId?: string;
      stateId?: string;
      startDate?: string;
      targetDate?: string;
      priority?: number;
      labelIds?: string[];
      templateId: string;
    } = {
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

    const response = await linearGraphQL<ProjectCreateResponse>(apiKey, CREATE_PROJECT_MUTATION, {
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
    .array(
      z
        .string()
        .refine(noControlChars, "Control characters not allowed")
        .refine(noPathTraversal, "Path traversal not allowed")
        .refine(noCommandInjection, "Invalid characters detected"),
    )
    .optional()
    .describe("Label names or IDs"),
});

const updateProjectOutput = z.object({
  success: z.boolean(),
  project: z.object({ id: z.string(), name: z.string(), url: z.string() }),
  estimatedTokens: z.number(),
});

type UpdateProjectInput = z.infer<typeof updateProjectInput>;
type UpdateProjectOutput = z.infer<typeof updateProjectOutput>;

interface ProjectUpdateResponse {
  projectUpdate: {
    success: boolean;
    project: { id: string; name: string; url: string };
  };
}

export const updateProject: ToolDescriptor<UpdateProjectInput, UpdateProjectOutput> = {
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

    const response = await linearGraphQL<ProjectUpdateResponse>(apiKey, UPDATE_PROJECT_MUTATION, {
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

type DeleteProjectInput = z.infer<typeof deleteProjectInput>;
type DeleteProjectOutput = z.infer<typeof deleteProjectOutput>;

interface ProjectDeleteResponse {
  projectDelete: { success: boolean };
}

export const deleteProject: ToolDescriptor<DeleteProjectInput, DeleteProjectOutput> = {
  id: "linear.delete_project",
  name: "Delete Linear Project",
  description: "Delete a project in Linear",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: deleteProjectInput,
  output: deleteProjectOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<ProjectDeleteResponse>(apiKey, DELETE_PROJECT_MUTATION, {
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

type ArchiveProjectInput = z.infer<typeof archiveProjectInput>;
type ArchiveProjectOutput = z.infer<typeof archiveProjectOutput>;

interface ProjectArchiveResponse {
  projectArchive: {
    success: boolean;
    entity?: { id: string; name: string; archivedAt: string };
  };
}

export const archiveProject: ToolDescriptor<ArchiveProjectInput, ArchiveProjectOutput> = {
  id: "linear.archive_project",
  name: "Archive Linear Project",
  description: "Archive a project in Linear",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: archiveProjectInput,
  output: archiveProjectOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<ProjectArchiveResponse>(apiKey, ARCHIVE_PROJECT_MUTATION, {
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

const LIST_TEMPLATES_DEFAULT_TYPE = "project" as const;
const LIST_TEMPLATES_DEFAULT_LIMIT = 50;

const listProjectTemplatesOutput = z.object({
  templates: z.array(
    z.object({
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
    }),
  ),
  totalTemplates: z.number(),
  estimatedTokens: z.number(),
});

type ListProjectTemplatesInput = z.infer<typeof listProjectTemplatesInput>;
type ListProjectTemplatesOutput = z.infer<typeof listProjectTemplatesOutput>;

interface TemplatesListResponse {
  templates?: Array<{
    id: string;
    name: string;
    description?: string | null;
    type?: string | null;
    templateData?: unknown;
    createdAt?: string | null;
    updatedAt?: string | null;
  }> | null;
}

interface ListedTemplateData {
  projectId?: string;
  teamId?: string;
  title?: string;
  descriptionData?: unknown;
  descriptionText?: string;
  stateId?: string;
  statusId?: string;
  priority?: number;
  labelIds?: string[];
  initiativeIds?: string[];
  memberIds?: string[];
  teamIds?: string[];
  projectMilestones?: unknown[];
  initialIssues?: unknown[];
  [key: string]: unknown;
}

/** Parse templateData (JSON string or object) into a typed shape; null on failure. */
function parseListedTemplateData(raw: unknown): ListedTemplateData | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ListedTemplateData;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") {
    return raw as ListedTemplateData;
  }
  return null;
}

export const listProjectTemplates: ToolDescriptor<
  ListProjectTemplatesInput,
  ListProjectTemplatesOutput
> = {
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
    const response = await linearGraphQL<TemplatesListResponse>(apiKey, LIST_TEMPLATES_QUERY, {});

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

        const templateObj: {
          id: string;
          name: string;
          description?: string;
          type: string;
          projectId?: string;
          teamId?: string;
          createdAt?: string;
          updatedAt?: string;
          content?: {
            title?: string;
            descriptionData?: unknown;
            descriptionText?: string;
            stateId?: string;
            statusId?: string;
            priority?: number;
            labelIds?: string[];
            initiativeIds?: string[];
            memberIds?: string[];
            teamIds?: string[];
            projectMilestones?: unknown[];
            initialIssues?: unknown[];
          };
        } = {
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

type GetTemplateInput = z.infer<typeof getTemplateInput>;
type GetTemplateOutput = z.infer<typeof getTemplateOutput>;

interface TemplateResponse {
  template: {
    id: string;
    name: string;
    description?: string | null;
    type?: string | null;
    templateData?: unknown;
    team?: { id: string; name: string } | null;
    createdAt?: string;
    updatedAt?: string;
  } | null;
}

/** Parse templateData (JSON string or object) into a record; empty object on failure. */
function parseTemplateRecord(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return {};
}

/** Extract plain text from ProseMirror descriptionData. */
function extractPlainText(descriptionData: unknown): string | undefined {
  if (!descriptionData || typeof descriptionData !== "object") {
    return undefined;
  }

  const data = descriptionData as {
    content?: Array<{ content?: Array<{ text?: string }> }>;
  };

  if (!data.content || !Array.isArray(data.content)) {
    return undefined;
  }

  const texts: string[] = [];

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

export const getTemplate: ToolDescriptor<GetTemplateInput, GetTemplateOutput> = {
  id: "linear.get_template",
  name: "Get Linear Template",
  description: "Get detailed information about a specific Linear template",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: getTemplateInput,
  output: getTemplateOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<TemplateResponse>(apiKey, GET_TEMPLATE_QUERY, {
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
      descriptionData:
        typeof parsedData.descriptionData === "object"
          ? (parsedData.descriptionData as Record<string, unknown>)
          : undefined,
      descriptionText,
      stateId: typeof parsedData.stateId === "string" ? parsedData.stateId : undefined,
      statusId: typeof parsedData.statusId === "string" ? parsedData.statusId : undefined,
      priority: typeof parsedData.priority === "number" ? parsedData.priority : undefined,
      projectId: typeof parsedData.projectId === "string" ? parsedData.projectId : undefined,
      teamId: typeof parsedData.teamId === "string" ? parsedData.teamId : undefined,
      labelIds: Array.isArray(parsedData.labelIds)
        ? (parsedData.labelIds as string[])
        : undefined,
    };

    const baseData = {
      id: response.template.id,
      name: response.template.name,
      type: (response.template.type || "issue") as "project" | "issue" | "recurringIssue",
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

type CreateProjectFromTemplateInput = z.infer<typeof createProjectFromTemplateInput>;
type CreateProjectFromTemplateOutput = z.infer<typeof createProjectFromTemplateOutput>;

interface ProjectFromTemplateCreateResponse {
  projectCreate: {
    success: boolean;
    project?: { id: string; name: string; url: string };
  };
}

export const createProjectFromTemplate: ToolDescriptor<
  CreateProjectFromTemplateInput,
  CreateProjectFromTemplateOutput
> = {
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

    const mutationInput: {
      name: string;
      teamIds: string[];
      templateId: string;
      description?: string;
      leadId?: string;
      startDate?: string;
      targetDate?: string;
    } = {
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

    const response = await linearGraphQL<ProjectFromTemplateCreateResponse>(
      apiKey,
      CREATE_PROJECT_FROM_TEMPLATE_MUTATION,
      { input: mutationInput },
    );

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
  cycles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      number: z.number().optional(),
      team: z.object({ id: z.string(), name: z.string() }).optional(),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
    }),
  ),
  totalCycles: z.number(),
  estimatedTokens: z.number(),
});

type ListCyclesInput = z.infer<typeof listCyclesInput>;
type ListCyclesOutput = z.infer<typeof listCyclesOutput>;

interface CyclesListResponse {
  cycles: {
    nodes: Array<{
      id: string;
      name: string;
      number?: number | null;
      team?: { id: string; name: string } | null;
      startsAt?: string | null;
      endsAt?: string | null;
      createdAt?: string | null;
      updatedAt?: string | null;
    }>;
  } | null;
}

export const listCycles: ToolDescriptor<ListCyclesInput, ListCyclesOutput> = {
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
    const filter: Record<string, unknown> = {};
    if (args.team) {
      filter.team = { name: { eq: args.team } };
    }
    if (args.query) {
      filter.name = { contains: args.query };
    }
    if (args.includeArchived !== undefined) {
      filter.includeArchived = args.includeArchived;
    }

    const response = await linearGraphQL<CyclesListResponse>(
      apiKey,
      LIST_CYCLES_QUERY,
      Object.keys(filter).length > 0 ? { filter } : {},
    );

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

type GetCycleInput = z.infer<typeof getCycleInput>;
type GetCycleOutput = z.infer<typeof getCycleOutput>;

interface CycleResponse {
  cycle: {
    id: string;
    name: string;
    description?: string | null;
    number?: number | null;
    team?: { id: string; name: string } | null;
    startsAt?: string | null;
    endsAt?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  } | null;
}

export const getCycle: ToolDescriptor<GetCycleInput, GetCycleOutput> = {
  id: "linear.get_cycle",
  name: "Get Linear Cycle",
  description: "Get detailed information about a specific Linear cycle",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: getCycleInput,
  output: getCycleOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<CycleResponse>(apiKey, GET_CYCLE_QUERY, { id: args.id });

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

type CreateCycleInput = z.infer<typeof createCycleInput>;
type CreateCycleOutput = z.infer<typeof createCycleOutput>;

interface CycleCreateResponse {
  cycleCreate: {
    success: boolean;
    cycle: { id: string; name: string; url: string };
  };
}

export const createCycle: ToolDescriptor<CreateCycleInput, CreateCycleOutput> = {
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
    const response = await linearGraphQL<CycleCreateResponse>(apiKey, CREATE_CYCLE_MUTATION, {
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

type UpdateCycleInput = z.infer<typeof updateCycleInput>;
type UpdateCycleOutput = z.infer<typeof updateCycleOutput>;

interface CycleUpdateResponse {
  cycleUpdate: {
    success: boolean;
    cycle: {
      id: string;
      name: string;
      number?: number;
      team?: { id: string; name: string } | null;
      startsAt?: string;
      endsAt?: string;
      updatedAt?: string;
    } | null;
  };
}

export const updateCycle: ToolDescriptor<UpdateCycleInput, UpdateCycleOutput> = {
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
    const mutationInput: { name?: string; startsAt?: string; endsAt?: string } = {};
    if (args.name !== undefined) mutationInput.name = args.name;
    if (args.startsAt !== undefined) mutationInput.startsAt = args.startsAt;
    if (args.endsAt !== undefined) mutationInput.endsAt = args.endsAt;

    const response = await linearGraphQL<CycleUpdateResponse>(apiKey, UPDATE_CYCLE_MUTATION, {
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
  teams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      key: z.string().optional(),
      description: z.string().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
      parent: z.object({ id: z.string(), name: z.string() }).optional(),
    }),
  ),
  totalTeams: z.number(),
  estimatedTokens: z.number(),
});

type ListTeamsInput = z.infer<typeof listTeamsInput>;
type ListTeamsOutput = z.infer<typeof listTeamsOutput>;

const LIST_TEAMS_DEFAULT_LIMIT = 50;

interface TeamsListResponse {
  teams: {
    nodes: Array<{
      id: string;
      key?: string | null;
      name: string;
      description?: string | null;
      createdAt?: string;
      updatedAt?: string;
      parent?: { id: string; name: string } | null;
    }>;
  } | null;
}

export const listTeams: ToolDescriptor<ListTeamsInput, ListTeamsOutput> = {
  id: "linear.list_teams",
  name: "List Linear Teams",
  description: "List teams from Linear workspace",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: listTeamsInput,
  output: listTeamsOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const variables: Record<string, unknown> = {
      first: args.limit ?? LIST_TEAMS_DEFAULT_LIMIT,
      orderBy: args.orderBy ?? "updatedAt",
    };

    if (args.query || args.includeArchived !== undefined) {
      const filter: Record<string, unknown> = {};
      if (args.query) {
        filter.name = { contains: args.query };
      }
      if (args.includeArchived !== undefined) {
        filter.includeArchived = args.includeArchived;
      }
      variables.filter = filter;
    }

    const response = await linearGraphQL<TeamsListResponse>(apiKey, LIST_TEAMS_QUERY, variables);

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

type GetTeamInput = z.infer<typeof getTeamInput>;
type GetTeamOutput = z.infer<typeof getTeamOutput>;

interface TeamResponse {
  team: {
    id: string;
    key?: string | null;
    name: string;
    description?: string | null;
    createdAt?: string;
    updatedAt?: string;
  } | null;
}

export const getTeam: ToolDescriptor<GetTeamInput, GetTeamOutput> = {
  id: "linear.get_team",
  name: "Get Linear Team",
  description: "Get detailed information about a specific Linear team",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: getTeamInput,
  output: getTeamOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<TeamResponse>(apiKey, GET_TEAM_QUERY, { id: args.query });

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
  users: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      active: z.boolean().optional(),
      createdAt: z.string().optional(),
    }),
  ),
  totalUsers: z.number(),
  estimatedTokens: z.number(),
});

type ListUsersInput = z.infer<typeof listUsersInput>;
type ListUsersOutput = z.infer<typeof listUsersOutput>;

interface UsersListResponse {
  users: {
    nodes: Array<{
      id: string;
      name: string;
      email: string;
      active?: boolean | null;
      createdAt?: string | null;
    }>;
  } | null;
}

export const listUsers: ToolDescriptor<ListUsersInput, ListUsersOutput> = {
  id: "linear.list_users",
  name: "List Linear Users",
  description: "List users from Linear workspace",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: listUsersInput,
  output: listUsersOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<UsersListResponse>(apiKey, LIST_USERS_QUERY, {});

    const users = response.users?.nodes || [];

    // Client-side filtering if query provided (matches marketplace behavior).
    const filteredUsers = args.query
      ? users.filter(
          (user) =>
            user.name.toLowerCase().includes(args.query!.toLowerCase()) ||
            user.email.toLowerCase().includes(args.query!.toLowerCase()),
        )
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

type FindUserInput = z.infer<typeof findUserInput>;
type FindUserOutput = z.infer<typeof findUserOutput>;

interface FindUserResponse {
  users: {
    nodes: Array<{
      id: string;
      name: string;
      email: string;
      displayName?: string | null;
      avatarUrl?: string | null;
      active?: boolean | null;
      admin?: boolean | null;
      createdAt?: string | null;
    }>;
  } | null;
}

export const findUser: ToolDescriptor<FindUserInput, FindUserOutput> = {
  id: "linear.find_user",
  name: "Find Linear User",
  description: "Find a specific user in Linear workspace",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: findUserInput,
  output: findUserOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<FindUserResponse>(apiKey, FIND_USER_QUERY, {
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
  comments: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      user: z.object({ id: z.string(), name: z.string(), email: z.string() }).optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  totalComments: z.number(),
  estimatedTokens: z.number(),
});

type ListCommentsInput = z.infer<typeof listCommentsInput>;
type ListCommentsOutput = z.infer<typeof listCommentsOutput>;

interface IssueCommentsResponse {
  issue: {
    id: string;
    comments?: {
      nodes: Array<{
        id: string;
        body?: string | null;
        user?: { id: string; name: string; email: string } | null;
        createdAt?: string;
        updatedAt?: string;
      }>;
    } | null;
  } | null;
}

export const listComments: ToolDescriptor<ListCommentsInput, ListCommentsOutput> = {
  id: "linear.list_comments",
  name: "List Linear Comments",
  description: "List comments for a specific Linear issue",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: listCommentsInput,
  output: listCommentsOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<IssueCommentsResponse>(apiKey, LIST_COMMENTS_QUERY, {
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

type CreateCommentInput = z.infer<typeof createCommentInput>;
type CreateCommentOutput = z.infer<typeof createCommentOutput>;

interface CommentCreateResponse {
  commentCreate: {
    success: boolean;
    comment?: {
      id: string;
      body: string;
      createdAt: string;
    };
  };
}

export const createComment: ToolDescriptor<CreateCommentInput, CreateCommentOutput> = {
  id: "linear.create_comment",
  name: "Create Linear Comment",
  description: "Create a comment on a Linear issue",
  auth: ["LINEAR_API_KEY"],
  wraps: { type: "rest" },
  input: createCommentInput,
  output: createCommentOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.LINEAR_API_KEY;

    const response = await linearGraphQL<CommentCreateResponse>(apiKey, CREATE_COMMENT_MUTATION, {
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
