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
