/**
 * `context7.resolve-library-id` + `context7.get-library-docs` — WS-A bulk catalog port.
 *
 * Ported from the marketplace wrappers `core/tools/context7/resolve-library-id.ts`
 * and `get-library-docs.ts` into gateway {@link ToolDescriptor}s, applying the §6.2
 * adapter rules.
 *
 * KEYLESS (auth: []): the Context7 public API is usable WITHOUT a key (low rate
 * limits); an optional `CONTEXT7_API_KEY` raises limits. The marketplace wrappers
 * relayed through the `@upstash/context7-mcp` stdio MCP server — which is exactly
 * the harness coupling the gateway must shed — so this port talks DIRECTLY to the
 * Context7 public HTTP API (verified against the Context7 API guide):
 *
 *   GET https://context7.com/api/v2/libs/search?libraryName=&query=   (JSON results)
 *   GET https://context7.com/api/v2/context?libraryId=&query=&type=   (JSON or txt docs)
 *
 * Because `auth: []`, the gateway runner resolves an EMPTY secret set, so by default
 * no key is present and no Authorization header is sent (true keyless). If an adopter
 * declares `CONTEXT7_API_KEY` and it reaches `ctx.secrets`, the handler adds a Bearer
 * header — still CTX-only (never an env read), still a self-contained portable unit
 * importing ONLY `zod`.
 *
 * `ToolDescriptor` is declared LOCALLY (structurally) so the runtime `.js` has no
 * gateway-source dependency.
 */
import { z } from "zod";

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
const XSS = [/<script/i, /<\/script/i, /javascript:/i, /on\w+\s*=/i, /<iframe/i];
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]");

const noPathTraversal = (s: string): boolean => !PATH_TRAVERSAL.some((p) => p.test(s));
const noCommandInjection = (s: string): boolean => !COMMAND_INJECTION.some((p) => p.test(s));
const noXSS = (s: string): boolean => !XSS.some((p) => p.test(s));
const noControlChars = (s: string): boolean => !CONTROL_CHARS.test(s);

/** ~4 chars per token over the JSON/text encoding (mirrors the marketplace estimate). */
function estimateTokens(data: unknown): number {
  const json = typeof data === "string" ? data : JSON.stringify(data);
  return Math.ceil(json.length / 4);
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

// ── Shared constants ──────────────────────────────────────────────────────────

const CONTEXT7_BASE = "https://context7.com/api/v2";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_QUERY = "documentation";
const DEFAULT_MODE = "code" as const;
const DEFAULT_PAGE = 1;

/**
 * Build request headers. Context7 is keyless; an Authorization header is added ONLY
 * when an optional `CONTEXT7_API_KEY` is present in `ctx.secrets` (raises rate limits).
 */
function buildHeaders(secrets: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  const key = secrets.CONTEXT7_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

// ════════════════════════════════════════════════════════════════════════════
// context7.resolve-library-id
// ════════════════════════════════════════════════════════════════════════════

// NOTE: no `.default()` on input fields (input type must equal output type for
// `z.ZodType<I>`); defaults applied in the handler.
const resolveInput = z.object({
  libraryName: z
    .string()
    .min(1, "Library name is required")
    .max(256, "Library name too long (max 256 characters)")
    .refine(noPathTraversal, "Path traversal detected")
    .refine(noCommandInjection, "Invalid characters detected")
    .refine(noXSS, "XSS patterns not allowed")
    .refine(noControlChars, "Control characters not allowed")
    .describe('Name of the library to search for (e.g., "react", "lodash")'),
  query: z
    .string()
    .min(1, "Query is required")
    .max(500, "Query too long (max 500 characters)")
    .refine(noControlChars, "Control characters not allowed")
    .optional()
    .describe("User question/task for ranking results by relevance"),
});

const resolveOutput = z.object({
  libraries: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      codeSnippets: z.number().optional(),
      sourceReputation: z.enum(["High", "Medium", "Low", "Unknown"]).optional(),
      benchmarkScore: z.number().optional(),
      versions: z.array(z.string()).optional(),
    }),
  ),
  totalResults: z.number(),
});

type ResolveInput = z.infer<typeof resolveInput>;
type ResolveOutput = z.infer<typeof resolveOutput>;

interface SearchResultRow {
  id: string;
  title: string;
  description?: string;
  totalSnippets?: number;
  trustScore?: number;
  benchmarkScore?: number;
  versions?: string[];
}
interface SearchResponseBody {
  results?: SearchResultRow[];
}

/** Map a numeric trustScore (0-10) to the marketplace reputation enum. */
function reputationFromTrust(trust?: number): ResolveOutput["libraries"][number]["sourceReputation"] {
  if (trust === undefined) return undefined;
  if (trust >= 8) return "High";
  if (trust >= 5) return "Medium";
  if (trust >= 1) return "Low";
  return "Unknown";
}

export const resolveLibraryId: ToolDescriptor<ResolveInput, ResolveOutput> = {
  id: "context7.resolve-library-id",
  name: "Context7 Resolve Library ID",
  description:
    "Resolve a library name to Context7-compatible library IDs (keyless; optional CONTEXT7_API_KEY raises rate limits).",
  auth: [],
  wraps: { type: "rest" },
  input: resolveInput,
  output: resolveOutput,
  handler: async (args, ctx) => {
    const params = new URLSearchParams({
      libraryName: args.libraryName,
      query: args.query ?? DEFAULT_QUERY,
    });

    const res = await activeFetch(`${CONTEXT7_BASE}/libs/search?${params.toString()}`, {
      method: "GET",
      headers: buildHeaders(ctx.secrets),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Context7 search HTTP ${res.status}`);
    }

    const body = (await res.json()) as SearchResponseBody;
    const rows = body.results ?? [];
    const libraries = rows.map((r) => ({
      id: r.id,
      name: r.title,
      ...(r.description ? { description: r.description.substring(0, 200) } : {}),
      ...(r.totalSnippets !== undefined ? { codeSnippets: r.totalSnippets } : {}),
      ...(reputationFromTrust(r.trustScore)
        ? { sourceReputation: reputationFromTrust(r.trustScore) }
        : {}),
      ...(r.benchmarkScore !== undefined ? { benchmarkScore: r.benchmarkScore } : {}),
      ...(r.versions ? { versions: r.versions } : {}),
    }));

    return { libraries, totalResults: libraries.length };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// context7.get-library-docs
// ════════════════════════════════════════════════════════════════════════════

const docsInput = z.object({
  context7CompatibleLibraryID: z
    .string()
    .min(1, "Library ID is required")
    .max(512, "Library ID too long (max 512 characters)")
    .refine(noPathTraversal, "Path traversal detected")
    .refine(noCommandInjection, "Invalid characters detected")
    .refine(noXSS, "XSS patterns not allowed")
    .refine(noControlChars, "Control characters not allowed")
    .describe("Context7 library ID from resolve-library-id (format: /owner/repo)"),
  mode: z
    .enum(["code", "info"])
    .optional()
    .describe('Documentation mode: "code" (default) for API/code, "info" for conceptual guides'),
  topic: z
    .string()
    .max(256, "Topic too long (max 256 characters)")
    .refine((v) => noCommandInjection(v), "Invalid characters detected in topic")
    .refine((v) => noXSS(v), "XSS patterns not allowed in topic")
    .refine((v) => noControlChars(v), "Control characters not allowed in topic")
    .optional()
    .describe("Topic to focus documentation on"),
  page: z
    .number()
    .int("Page must be an integer")
    .min(1, "Page must be at least 1")
    .max(10, "Page must not exceed 10")
    .optional()
    .describe("Page number for pagination"),
});

const docsOutput = z.object({
  libraryName: z.string().describe("Library name derived from libraryId"),
  libraryId: z.string().describe("Context7 library ID"),
  content: z.string().describe("Documentation content"),
  fetchedAt: z.string().describe("ISO timestamp when docs were fetched"),
  version: z.string().optional().describe("Library version if detected"),
  mode: z.enum(["code", "info"]).describe("Documentation mode used"),
  topic: z.string().optional().describe("Topic filter applied"),
  page: z.number().describe("Page number"),
  estimatedTokens: z.number().describe("Estimated token count"),
});

type DocsInput = z.infer<typeof docsInput>;
type DocsOutput = z.infer<typeof docsOutput>;

/**
 * Derive a library name from a Context7 library ID.
 *   "/facebook/react" -> "react"
 *   "/DefinitelyTyped/@types/node" -> "@types/node"
 */
function deriveLibraryName(libraryId: string): string {
  const parts = libraryId.split("/").filter(Boolean);
  if (parts.length >= 2 && parts[parts.length - 2]?.startsWith("@")) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return parts[parts.length - 1] || libraryId;
}

export const getLibraryDocs: ToolDescriptor<DocsInput, DocsOutput> = {
  id: "context7.get-library-docs",
  name: "Context7 Get Library Docs",
  description:
    "Fetch up-to-date documentation for a Context7 library ID (keyless; optional CONTEXT7_API_KEY raises rate limits).",
  auth: [],
  wraps: { type: "rest" },
  input: docsInput,
  output: docsOutput,
  handler: async (args, ctx) => {
    const params = new URLSearchParams({
      libraryId: args.context7CompatibleLibraryID,
      query: args.topic ?? DEFAULT_QUERY,
      type: "txt",
    });

    const res = await activeFetch(`${CONTEXT7_BASE}/context?${params.toString()}`, {
      method: "GET",
      headers: buildHeaders(ctx.secrets),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Context7 docs HTTP ${res.status}`);
    }

    const content = await res.text();

    return {
      libraryName: deriveLibraryName(args.context7CompatibleLibraryID),
      libraryId: args.context7CompatibleLibraryID,
      content,
      fetchedAt: new Date().toISOString(),
      mode: args.mode ?? DEFAULT_MODE,
      ...(args.topic ? { topic: args.topic } : {}),
      page: args.page ?? DEFAULT_PAGE,
      estimatedTokens: estimateTokens(content),
    };
  },
};
