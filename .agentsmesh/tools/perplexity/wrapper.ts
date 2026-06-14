/**
 * `perplexity.search` + `perplexity.ask` — WS-A bulk catalog port.
 *
 * Ported from the marketplace wrappers `core/tools/perplexity/perplexity_search.ts`
 * and `perplexity_ask.ts` into gateway {@link ToolDescriptor}s, applying the §6.2
 * adapter rules (identical to the A0-CATALOG `linear` port):
 *
 *  1. `name: 'perplexity.search'` → `id` + a display `name`.
 *  2. `parameters` → `input`; the internal output Zod is lifted to `output`.
 *  3. The `init.js` side-effect + `createPerplexityClientAsync()` (which resolves
 *     the key from env/1Password ITSELF) is replaced by `auth: ["PERPLEXITY_API_KEY"]`;
 *     each handler builds the request from `ctx.secrets.PERPLEXITY_API_KEY` and sends
 *     it as a Bearer token (CTX-only contract, descriptor.ts:38-43) — it never reads
 *     an env var or constructs a client outside `ctx`.
 *  4. The `@praetorian/claude-tool-sdk` validators are INLINED here so this wrapper is
 *     a SELF-CONTAINED portable unit: it imports ONLY `zod` from node_modules and no
 *     gateway source, so bare Node can serve the compiled `wrapper.js` (SF-1).
 *  5. No `${CLAUDE_PLUGIN_ROOT}`, no `.claude` paths, no `@praetorian/claude-tool-sdk`,
 *     no HTTP-port SDK — raw `fetch` to the Perplexity API endpoints with the key in the
 *     `Authorization` header keeps this dependency-free.
 *
 * `ToolDescriptor` is declared LOCALLY (structurally) so the runtime `.js` has no
 * gateway-source dependency.
 *
 * Endpoints (client.ts:36, 159, 225):
 *   POST https://api.perplexity.ai/search           — web search
 *   POST https://api.perplexity.ai/chat/completions — conversational (sonar-pro)
 */
import { z } from "zod";

/**
 * The gateway's `ToolDescriptor` contract, declared LOCALLY (structurally) so this
 * wrapper has ZERO compile-time or runtime dependency on gateway source. The gateway
 * resolves and validates tools structurally (runner.ts / drift.ts duck-type), so a
 * structural match is exactly equivalent to importing the type.
 * Mirrors `gateway/src/execute/descriptor.ts:15-36`.
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

const PERPLEXITY_BASE = "https://api.perplexity.ai";
/** sonar-pro is the marketplace `ask` model (client.ts:57-58). */
const ASK_MODEL = "sonar-pro";
const REQUEST_TIMEOUT_MS = 60_000;
/** Reason/research use longer-running Sonar models (client.ts SONAR_MODELS + 120s timeout). */
const RESEARCH_MODEL = "sonar-deep-research";
const REASON_MODEL = "sonar-reasoning-pro";
const LONG_REQUEST_TIMEOUT_MS = 120_000;
/** Truncate responses for token efficiency (marketplace keeps first 3000 chars). */
const MAX_CONTENT_CHARS = 3000;

/** Append a compact Sources list and truncate for token efficiency. */
function finalizeContent(content: string, citations: string[]): string {
  let out = content;
  if (citations.length > 0) {
    out += "\n\nSources:\n" + citations.map((u) => `- ${u}`).join("\n");
  }
  return out.length > MAX_CONTENT_CHARS
    ? out.substring(0, MAX_CONTENT_CHARS) + "\n... [truncated for token efficiency]"
    : out;
}

// ════════════════════════════════════════════════════════════════════════════
// perplexity.search
// ════════════════════════════════════════════════════════════════════════════

// NOTE: no `.default()` on input fields — `ToolDescriptor.input: z.ZodType<I>`
// requires the schema's input and output types to coincide; `.default()` diverges
// them. Defaults are applied inside the handler.
const searchInput = z.object({
  query: z
    .string()
    .min(1, "Query cannot be empty")
    .refine(noControlChars, "Control characters not allowed")
    .refine(noPathTraversal, "Path traversal not allowed")
    .refine(noCommandInjection, "Invalid characters detected")
    .describe("Search query string"),
  max_results: z
    .number()
    .int()
    .min(1, "max_results must be at least 1")
    .max(20, "max_results cannot exceed 20")
    .optional()
    .describe("Maximum number of results to return (1-20, default: 10)"),
  max_tokens_per_page: z
    .number()
    .int()
    .min(256, "max_tokens_per_page must be at least 256")
    .max(2048, "max_tokens_per_page cannot exceed 2048")
    .optional()
    .describe("Maximum tokens to extract per webpage (default: 1024)"),
  country: z
    .string()
    .length(2, "Country code must be 2 characters (ISO 3166-1 alpha-2)")
    .regex(/^[A-Z]{2}$/, "Country code must be uppercase letters")
    .optional()
    .describe("ISO 3166-1 alpha-2 country code (e.g., US, GB)"),
});

const searchOutput = z.object({
  content: z.string().describe("Search results as plain text"),
  metadata: z
    .object({
      query: z.string(),
      resultCount: z.number().optional(),
    })
    .optional(),
});

type SearchInput = z.infer<typeof searchInput>;
type SearchOutput = z.infer<typeof searchOutput>;

interface SearchResultRow {
  title: string;
  url: string;
  snippet?: string;
}
interface SearchResponseBody {
  results?: SearchResultRow[];
}

export const perplexitySearch: ToolDescriptor<SearchInput, SearchOutput> = {
  id: "perplexity.search",
  name: "Perplexity Search",
  description: "Perform web search using the Perplexity Search API with ranked results.",
  auth: ["PERPLEXITY_API_KEY"],
  wraps: { type: "rest" },
  input: searchInput,
  output: searchOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.PERPLEXITY_API_KEY;

    const res = await activeFetch(`${PERPLEXITY_BASE}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        query: args.query,
        ...(args.max_results !== undefined ? { max_results: args.max_results } : {}),
        ...(args.country !== undefined ? { country: args.country } : {}),
        ...(args.max_tokens_per_page !== undefined
          ? { max_tokens_per_page: args.max_tokens_per_page }
          : {}),
      }),
    });

    if (!res.ok) {
      throw new Error(`Perplexity search HTTP ${res.status}`);
    }

    const body = (await res.json()) as SearchResponseBody;
    const results = body.results ?? [];
    const citations = results.map((r) => r.url);
    const rawContent = results
      .map((r) => `[${r.title}](${r.url}): ${r.snippet ?? ""}`)
      .join("\n");

    if (!rawContent || rawContent.trim() === "") {
      throw new Error("Empty response from Perplexity search");
    }

    return {
      content: finalizeContent(rawContent, citations),
      metadata: { query: args.query, resultCount: results.length },
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// perplexity.ask
// ════════════════════════════════════════════════════════════════════════════

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]).describe("Role of the message sender"),
  content: z
    .string()
    .min(1, "Message content cannot be empty")
    .refine(noControlChars, "Control characters not allowed")
    .describe("The content of the message"),
});

const askInput = z
  .object({
    messages: z
      .array(messageSchema)
      .min(1, "At least one message is required")
      .optional()
      .describe("Array of conversation messages"),
    query: z
      .string()
      .min(1, "Query cannot be empty")
      .optional()
      .describe("Convenience: auto-wrapped into a messages array"),
  })
  .refine((data) => data.messages != null || data.query != null, "Either messages or query is required");

const askOutput = z.object({
  content: z.string().describe("Response as markdown-formatted text"),
  metadata: z
    .object({
      messageCount: z.number(),
    })
    .optional(),
});

type AskInput = z.infer<typeof askInput>;
type AskOutput = z.infer<typeof askOutput>;

interface ChatResponseBody {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
}

export const perplexityAsk: ToolDescriptor<AskInput, AskOutput> = {
  id: "perplexity.ask",
  name: "Perplexity Ask",
  description: "Conversational AI with real-time web search using the Perplexity sonar-pro model.",
  auth: ["PERPLEXITY_API_KEY"],
  wraps: { type: "rest" },
  input: askInput,
  output: askOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.PERPLEXITY_API_KEY;

    const effectiveMessages =
      args.messages ?? [{ role: "user" as const, content: args.query as string }];

    const res = await activeFetch(`${PERPLEXITY_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({ model: ASK_MODEL, messages: effectiveMessages }),
    });

    if (!res.ok) {
      throw new Error(`Perplexity chat/completions HTTP ${res.status}`);
    }

    const body = (await res.json()) as ChatResponseBody;
    const content = body.choices?.[0]?.message?.content ?? "";

    if (!content || content.trim() === "") {
      throw new Error("Empty response from Perplexity ask");
    }

    return {
      content: finalizeContent(content, body.citations ?? []),
      metadata: { messageCount: effectiveMessages.length },
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// perplexity.research
// ════════════════════════════════════════════════════════════════════════════

const researchInput = z
  .object({
    messages: z
      .array(messageSchema)
      .min(1, "At least one message is required")
      .optional()
      .describe("Array of conversation messages"),
    query: z
      .string()
      .min(1, "Query cannot be empty")
      .optional()
      .describe("Convenience: auto-wrapped into a messages array"),
    strip_thinking: z
      .boolean()
      .optional()
      .describe("If true, removes <think>...</think> tags to save context tokens"),
  })
  .refine((data) => data.messages != null || data.query != null, "Either messages or query is required");

const researchOutput = z.object({
  content: z.string().describe("Research findings as plain text with citations"),
  metadata: z
    .object({
      messageCount: z.number(),
      citationCount: z.number().optional(),
      thinkingStripped: z.boolean(),
    })
    .optional(),
});

type ResearchInput = z.infer<typeof researchInput>;
type ResearchOutput = z.infer<typeof researchOutput>;

export const perplexityResearch: ToolDescriptor<ResearchInput, ResearchOutput> = {
  id: "perplexity.research",
  name: "Perplexity Research",
  description: "Deep research with comprehensive analysis and citations.",
  auth: ["PERPLEXITY_API_KEY"],
  wraps: { type: "rest" },
  input: researchInput,
  output: researchOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.PERPLEXITY_API_KEY;
    const effectiveMessages =
      args.messages ?? [{ role: "user" as const, content: args.query as string }];

    const res = await activeFetch(`${PERPLEXITY_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(LONG_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({ model: RESEARCH_MODEL, messages: effectiveMessages }),
    });

    if (!res.ok) {
      throw new Error(`Perplexity chat/completions HTTP ${res.status}`);
    }

    const body = (await res.json()) as ChatResponseBody;
    let content = body.choices?.[0]?.message?.content ?? "";

    if (args.strip_thinking) {
      content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    }

    if (!content || content.trim() === "") {
      throw new Error("Empty response from Perplexity research");
    }

    // Count inline [N] citation markers on the answer BEFORE appending the Sources list.
    const citationMatches = content.match(/\[\d+\]/g);
    const citationCount = citationMatches ? citationMatches.length : 0;

    const citations = body.citations ?? [];
    if (citations.length > 0) {
      content += "\n\nSources:\n" + citations.map((u) => `- ${u}`).join("\n");
    }

    // Research keeps the first 8000 chars (more than the 3000 ask/search budget).
    const truncated =
      content.length > 8000
        ? content.substring(0, 8000) + "\n... [truncated for token efficiency]"
        : content;

    return {
      content: truncated,
      metadata: {
        messageCount: effectiveMessages.length,
        citationCount,
        thinkingStripped: args.strip_thinking || false,
      },
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// perplexity.reason
// ════════════════════════════════════════════════════════════════════════════

const reasonInput = z
  .object({
    messages: z
      .array(messageSchema)
      .min(1, "At least one message is required")
      .optional()
      .describe("Array of conversation messages"),
    query: z
      .string()
      .min(1, "Query cannot be empty")
      .optional()
      .describe("Convenience: auto-wrapped into a messages array"),
    strip_thinking: z
      .boolean()
      .optional()
      .describe("If true, removes <think>...</think> tags to save context tokens"),
  })
  .refine((data) => data.messages != null || data.query != null, "Either messages or query is required");

const reasonOutput = z.object({
  content: z.string().describe("Reasoning response, may include <think> tags"),
  metadata: z
    .object({
      messageCount: z.number(),
      thinkingStripped: z.boolean(),
      hasThinkingTags: z.boolean(),
    })
    .optional(),
});

type ReasonInput = z.infer<typeof reasonInput>;
type ReasonOutput = z.infer<typeof reasonOutput>;

export const perplexityReason: ToolDescriptor<ReasonInput, ReasonOutput> = {
  id: "perplexity.reason",
  name: "Perplexity Reason",
  description: "Advanced reasoning and problem-solving with step-by-step analysis.",
  auth: ["PERPLEXITY_API_KEY"],
  wraps: { type: "rest" },
  input: reasonInput,
  output: reasonOutput,
  handler: async (args, ctx) => {
    const apiKey = ctx.secrets.PERPLEXITY_API_KEY;
    const effectiveMessages =
      args.messages ?? [{ role: "user" as const, content: args.query as string }];

    const res = await activeFetch(`${PERPLEXITY_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(LONG_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({ model: REASON_MODEL, messages: effectiveMessages }),
    });

    if (!res.ok) {
      throw new Error(`Perplexity chat/completions HTTP ${res.status}`);
    }

    const body = (await res.json()) as ChatResponseBody;
    let content = body.choices?.[0]?.message?.content ?? "";

    if (args.strip_thinking) {
      content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    }

    if (!content || content.trim() === "") {
      throw new Error("Empty response from Perplexity reason");
    }

    // Detect think tags on the (possibly already stripped) content.
    const hasThinkingTags = content.includes("<think>") && content.includes("</think>");

    const citations = body.citations ?? [];
    if (citations.length > 0) {
      content += "\n\nSources:\n" + citations.map((u) => `- ${u}`).join("\n");
    }

    // Reasoning keeps the first 5000 chars.
    const truncated =
      content.length > 5000
        ? content.substring(0, 5000) + "\n... [truncated for token efficiency]"
        : content;

    return {
      content: truncated,
      metadata: {
        messageCount: effectiveMessages.length,
        thinkingStripped: args.strip_thinking || false,
        hasThinkingTags,
      },
    };
  },
};
