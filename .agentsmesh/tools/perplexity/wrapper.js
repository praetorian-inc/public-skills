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
// ── Inlined sanitizers (keep this wrapper a self-contained portable unit) ─────
const PATH_TRAVERSAL = [/\.\.\//, /\.\.\\/, /\.\.$/, /^\.\.$/, /~\//];
const COMMAND_INJECTION = [/[;&|`$]/, /\$\(/, /`[^`]*`/, /\|\|/, /&&/, />\s*\/|>>/, /<\s*\//];
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]");
const noPathTraversal = (s) => !PATH_TRAVERSAL.some((p) => p.test(s));
const noCommandInjection = (s) => !COMMAND_INJECTION.some((p) => p.test(s));
const noControlChars = (s) => !CONTROL_CHARS.test(s);
let activeFetch = (url, init) => globalThis.fetch(url, init);
/** TEST-ONLY: override the transport so no real HTTP happens in unit tests. */
export function __setFetch(fn) {
    activeFetch = fn;
}
/** TEST-ONLY: restore the default global `fetch`. */
export function __resetFetch() {
    activeFetch = (url, init) => globalThis.fetch(url, init);
}
// ── Shared constants ──────────────────────────────────────────────────────────
const PERPLEXITY_BASE = "https://api.perplexity.ai";
/** sonar-pro is the marketplace `ask` model (client.ts:57-58). */
const ASK_MODEL = "sonar-pro";
const REQUEST_TIMEOUT_MS = 60_000;
/** Truncate responses for token efficiency (marketplace keeps first 3000 chars). */
const MAX_CONTENT_CHARS = 3000;
/** Append a compact Sources list and truncate for token efficiency. */
function finalizeContent(content, citations) {
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
export const perplexitySearch = {
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
        const body = (await res.json());
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
export const perplexityAsk = {
    id: "perplexity.ask",
    name: "Perplexity Ask",
    description: "Conversational AI with real-time web search using the Perplexity sonar-pro model.",
    auth: ["PERPLEXITY_API_KEY"],
    wraps: { type: "rest" },
    input: askInput,
    output: askOutput,
    handler: async (args, ctx) => {
        const apiKey = ctx.secrets.PERPLEXITY_API_KEY;
        const effectiveMessages = args.messages ?? [{ role: "user", content: args.query }];
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
        const body = (await res.json());
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
