/**
 * Featurebase catalog wrappers — the full Featurebase REST surface ported to
 * gateway {@link ToolDescriptor}s (35 tools across posts, changelog, collections,
 * articles, comments, users, companies, webhooks, custom fields, boards).
 *
 * Ported from the marketplace `core/tools/featurebase/*.ts` wrappers, applying
 * the §6.2 adapter rules (mirrors `linear/wrapper.ts`):
 *
 *  1. `name: 'featurebase.<tool>'` → `id` + a display `name`.
 *  2. `parameters` → `input`; the internal output Zod is lifted to `output`.
 *     No `.default()` on input fields (it diverges `z.ZodType<I>`'s in/out
 *     types); defaults are applied inside each handler.
 *  3. The `init.js` side-effect + `createFeaturebaseClientAsync()` HTTPPort +
 *     `SecretsProvider` are replaced by `auth: ["FEATUREBASE_API_KEY"]`; each
 *     handler builds the request from `ctx.secrets.FEATUREBASE_API_KEY` (CTX-only
 *     contract) and sends it in the `X-API-Key` header — never an env read, never
 *     a client constructed outside `ctx`.
 *  4. The `@praetorian/claude-tool-sdk` validators + `estimateTokens` +
 *     `sanitizeErrorMessage` are inlined here so this wrapper is a SELF-CONTAINED
 *     portable unit: it imports ONLY `zod` and no gateway source, so bare Node can
 *     serve the compiled `wrapper.js` (SF-1, wrapper-resolve.ts).
 *  5. No `${CLAUDE_PLUGIN_ROOT}`, no `.claude` paths — a raw `fetch` to the
 *     Featurebase REST API (`https://do.featurebase.app`) via the injectable
 *     `activeFetch` transport seam.
 *
 * `ToolDescriptor` is declared LOCALLY (structurally) so the runtime `.js` has no
 * gateway-source dependency; the gateway resolves/validates tools by duck-typing.
 */
import { z } from "zod";

/**
 * The gateway's `ToolDescriptor` contract, declared LOCALLY (structurally) so
 * this wrapper has ZERO compile-time or runtime dependency on gateway source.
 * Mirrors `gateway/src/execute/descriptor.ts`.
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
// Identical to claude-tool-sdk/src/sanitize.ts and linear/wrapper.ts.

const PATH_TRAVERSAL = [/\.\.\//, /\.\.\\/, /\.\.$/, /^\.\.$/, /~\//];
const COMMAND_INJECTION = [/[;&|`$]/, /\$\(/, /`[^`]*`/, /\|\|/, /&&/, />\s*\/|>>/, /<\s*\//];
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]");

const validateNoPathTraversal = (s: string): boolean => !PATH_TRAVERSAL.some((p) => p.test(s));
const validateNoCommandInjection = (s: string): boolean => !COMMAND_INJECTION.some((p) => p.test(s));
const validateNoControlChars = (s: string): boolean => !CONTROL_CHARS.test(s);

/** ~4 chars per token over the JSON encoding (mirrors the marketplace estimate). */
function estimateTokens(data: unknown): number {
  const json = typeof data === "string" ? data : JSON.stringify(data);
  return Math.ceil(json.length / 4);
}

/**
 * Redact secrets/paths from an error message before it surfaces (mirrors the
 * marketplace `internal/sanitize-error.ts`).
 */
function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/api[_-]?key[=:]\s*\S+/gi, "apiKey=[REDACTED]")
    .replace(/sk_\w+/gi, "[API_KEY_REDACTED]")
    .replace(/\/Users\/[^/\s]+/g, "[PATH_REDACTED]");
}

/** A strict ID/filter field: rejects control chars, path traversal, injection. */
function safeId(describe: string) {
  return z
    .string()
    .min(1)
    .refine(validateNoControlChars, "Control characters not allowed")
    .refine(validateNoPathTraversal, "Path traversal not allowed")
    .refine(validateNoCommandInjection, "Invalid characters detected")
    .describe(describe);
}

/** Optional variant of {@link safeId} (no min-length). */
function safeOptional(describe: string) {
  return z
    .string()
    .refine((v) => validateNoControlChars(v), "Control characters not allowed")
    .refine((v) => validateNoPathTraversal(v), "Path traversal not allowed")
    .refine((v) => validateNoCommandInjection(v), "Invalid characters detected")
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

// ── Shared request helper (CTX-only: key passed in, never read from env) ──────

const FB_BASE = "https://do.featurebase.app";

type FbResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string };

type Query = Record<string, string | number | boolean | undefined>;

/**
 * Make a Featurebase REST request with `X-API-Key` auth via the injectable
 * `activeFetch` transport. Bodies are JSON by default; the comments API uses
 * `form: true` for `application/x-www-form-urlencoded` (comments-client.ts).
 */
async function fbRequest<T>(
  apiKey: string,
  method: "get" | "post" | "put" | "delete",
  path: string,
  opts?: { query?: Query; json?: unknown; form?: Record<string, string | number | boolean | undefined> },
): Promise<FbResult<T>> {
  const headers: Record<string, string> = { "X-API-Key": apiKey };
  const init: RequestInit = { method: method.toUpperCase(), headers };

  if (opts?.json !== undefined && (method === "post" || method === "put")) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.json);
  } else if (opts?.form && (method === "post" || method === "put")) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const fd = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) {
      if (v !== undefined) fd.append(k, String(v));
    }
    init.body = fd.toString();
  }

  let url = `${FB_BASE}/${path}`;
  if (opts?.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (path.includes("?") ? "&" : "?") + s;
  }

  const res = await activeFetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, message: sanitizeErrorMessage(text || `HTTP ${res.status}`) };
  }
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: true, status: res.status, data };
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  POSTS                                                                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const listPostsInput = z.object({
  limit: z.number().int().min(1).max(100).optional().describe("Number of posts to return (1-100, default 10)"),
  cursor: safeOptional("Pagination cursor from previous response"),
  categoryId: safeOptional("Filter by category ID"),
  statusId: safeOptional("Filter by status ID"),
  status: z.enum(["in-progress", "complete", "planned", "archived"]).optional().describe("Filter by status label"),
  tags: z.array(z.string()).optional().describe("Filter by tag names"),
  q: safeOptional("Search query for title/content"),
  sortBy: z.enum(["createdAt", "upvotes", "trending"]).optional().describe("Sort order (default createdAt)"),
});

const listPostsOutput = z.object({
  posts: z.array(
    z.object({
      id: z.string(),
      slug: z.string().optional(),
      title: z.string(),
      content: z.string(),
      status: z.string(),
      categoryId: z.string(),
      date: z.string(),
      lastModified: z.string(),
      upvotes: z.number(),
      commentCount: z.number().optional(),
      tags: z.array(z.string()),
      author: z.string().optional(),
      authorEmail: z.string().optional(),
    }),
  ),
  page: z.number(),
  totalPages: z.number(),
  totalResults: z.number(),
  estimatedTokens: z.number(),
});

type ListPostsInput = z.infer<typeof listPostsInput>;
type ListPostsOutput = z.infer<typeof listPostsOutput>;

interface PostNode {
  id: string;
  slug?: string;
  title: string;
  content?: string;
  categoryId?: string;
  postStatus?: { name: string; type?: string };
  postCategory?: { category: string };
  date?: string;
  lastModified?: string;
  upvotes?: number;
  commentCount?: number;
  postTags?: string[];
  author?: string;
  authorEmail?: string;
}

export const listPosts: ToolDescriptor<ListPostsInput, ListPostsOutput> = {
  id: "featurebase.list_posts",
  name: "List Featurebase Posts",
  description: "List posts with filtering and pagination.",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: listPostsInput,
  output: listPostsOutput,
  handler: async (args, ctx) => {
    const query: Query = { limit: args.limit ?? 10, sortBy: args.sortBy ?? "createdAt" };
    if (args.cursor) query.cursor = args.cursor;
    if (args.categoryId) query.categoryId = args.categoryId;
    if (args.statusId) query.statusId = args.statusId;
    if (args.status) query.status = args.status;
    if (args.tags) query.tags = args.tags.join(",");
    if (args.q) query.q = args.q;

    const res = await fbRequest<{
      results?: PostNode[];
      page?: number;
      totalPages?: number;
      totalResults?: number;
    }>(ctx.secrets.FEATUREBASE_API_KEY, "get", "v2/posts", { query });
    if (!res.ok) throw new Error(`FeatureBase API error: ${res.message}`);

    const postsArray = res.data.results ?? [];
    return {
      posts: postsArray.map((post) => ({
        id: post.id,
        slug: post.slug,
        title: post.title,
        content: (post.content || "").substring(0, 500),
        status: post.postStatus?.name || "unknown",
        categoryId: post.categoryId || "",
        date: post.date || new Date().toISOString(),
        lastModified: post.lastModified || new Date().toISOString(),
        upvotes: post.upvotes || 0,
        commentCount: post.commentCount,
        tags: post.postTags || [],
        author: post.author,
        authorEmail: post.authorEmail,
      })),
      page: res.data.page || 1,
      totalPages: res.data.totalPages || 1,
      totalResults: res.data.totalResults || postsArray.length,
      estimatedTokens: estimateTokens(res.data),
    };
  },
};

const getPostInput = z.object({ postId: safeId("Post ID to retrieve") });

const getPostOutput = z.object({
  post: z.object({
    id: z.string(),
    slug: z.string().optional(),
    title: z.string(),
    content: z.string(),
    status: z.string(),
    statusId: z.string().optional(),
    categoryId: z.string(),
    categoryName: z.string().optional(),
    date: z.string(),
    lastModified: z.string(),
    publishedAt: z.string().nullable().optional(),
    upvotes: z.number(),
    commentCount: z.number(),
    tags: z.array(z.string()),
    author: z.string().optional(),
    authorEmail: z.string().optional(),
  }),
  estimatedTokens: z.number(),
});

type GetPostInput = z.infer<typeof getPostInput>;
type GetPostOutput = z.infer<typeof getPostOutput>;

interface GetPostApi {
  id: string;
  slug?: string;
  title: string;
  content?: string;
  body?: string;
  postStatus?: { name: string };
  status?: string;
  statusId?: string;
  categoryId?: string;
  boardId?: string;
  postCategory?: { category: string };
  boardName?: string;
  date?: string;
  createdAt?: string;
  lastModified?: string;
  updatedAt?: string;
  publishedAt?: string | null;
  upvotes?: number;
  commentCount?: number;
  postTags?: string[];
  tags?: string[];
  author?: string;
  authorName?: string;
  authorEmail?: string;
}

export const getPost: ToolDescriptor<GetPostInput, GetPostOutput> = {
  id: "featurebase.get_post",
  name: "Get Featurebase Post",
  description: "Get a single post by ID.",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: getPostInput,
  output: getPostOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<GetPostApi>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "get",
      `v2/posts/${encodeURIComponent(args.postId)}`,
    );
    if (!res.ok) {
      throw new Error(
        res.status === 404 ? `Post not found: ${args.postId}` : `Failed to get post: ${res.message}`,
      );
    }
    const post = res.data;
    const postData = {
      id: post.id,
      slug: post.slug,
      title: post.title,
      content: post.content || post.body || "",
      status: post.postStatus?.name || post.status || "unknown",
      statusId: post.statusId,
      categoryId: post.categoryId || post.boardId || "",
      categoryName: post.postCategory?.category || post.boardName,
      date: post.date || post.createdAt || new Date().toISOString(),
      lastModified: post.lastModified || post.updatedAt || new Date().toISOString(),
      publishedAt: post.publishedAt || null,
      upvotes: post.upvotes || 0,
      commentCount: post.commentCount || 0,
      tags: post.postTags || post.tags || [],
      author: post.author || post.authorName,
      authorEmail: post.authorEmail,
    };
    return { post: postData, estimatedTokens: estimateTokens(postData) };
  },
};

const createPostInput = z.object({
  title: z
    .string()
    .min(1)
    .max(255, "title cannot exceed 255 characters")
    .refine(validateNoControlChars, "Control characters not allowed")
    .refine(validateNoPathTraversal, "Path traversal not allowed")
    .refine(validateNoCommandInjection, "Invalid characters detected")
    .describe("Post title"),
  content: z.string().min(1).describe("Post content (markdown supported)"),
  categoryId: safeId("Category ID where post will be created"),
  statusId: safeOptional("Optional status ID"),
  tags: z.array(z.string()).optional().describe("Optional tags"),
});

const createPostOutput = z.object({
  post: z.object({
    id: z.string(),
    slug: z.string().optional(),
    title: z.string(),
    content: z.string(),
    categoryId: z.string(),
    date: z.string(),
    lastModified: z.string(),
  }),
  estimatedTokens: z.number(),
});

type CreatePostInput = z.infer<typeof createPostInput>;
type CreatePostOutput = z.infer<typeof createPostOutput>;

interface CreatePostApi {
  id: string;
  slug?: string;
  title: string;
  content?: string;
  categoryId?: string;
  date?: string;
  createdAt?: string;
  lastModified?: string;
  updatedAt?: string;
}

export const createPost: ToolDescriptor<CreatePostInput, CreatePostOutput> = {
  id: "featurebase.create_post",
  name: "Create Featurebase Post",
  description: "Create a new post.",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: createPostInput,
  output: createPostOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<CreatePostApi>(ctx.secrets.FEATUREBASE_API_KEY, "post", "v2/posts", {
      json: {
        title: args.title,
        content: args.content,
        categoryId: args.categoryId,
        ...(args.statusId && { statusId: args.statusId }),
        ...(args.tags && { tags: args.tags }),
      },
    });
    if (!res.ok) throw new Error(`Failed to create post: ${res.message}`);
    const post = res.data;
    const postData = {
      id: post.id,
      slug: post.slug,
      title: post.title,
      content: post.content || "",
      categoryId: post.categoryId || "",
      date: post.date || post.createdAt || new Date().toISOString(),
      lastModified: post.lastModified || post.updatedAt || new Date().toISOString(),
    };
    return { post: postData, estimatedTokens: estimateTokens(postData) };
  },
};

const updatePostInput = z.object({
  postId: safeId("Post ID to update"),
  title: z
    .string()
    .max(255, "title cannot exceed 255 characters")
    .refine(validateNoControlChars, "Control characters not allowed")
    .optional()
    .describe("Post title"),
  content: z.string().optional().describe("Post content (markdown supported)"),
  statusId: z
    .string()
    .refine((v) => validateNoControlChars(v), "Control characters not allowed")
    .optional()
    .describe("Status ID"),
  tags: z.array(z.string()).optional().describe("Tags"),
});

const updatePostOutput = z.object({
  post: z.object({
    id: z.string(),
    slug: z.string().optional(),
    title: z.string(),
    content: z.string(),
    lastModified: z.string(),
  }),
  estimatedTokens: z.number(),
});

type UpdatePostInput = z.infer<typeof updatePostInput>;
type UpdatePostOutput = z.infer<typeof updatePostOutput>;

interface UpdatePostApi {
  id: string;
  slug?: string;
  title: string;
  content?: string;
  body?: string;
  lastModified?: string;
  updatedAt?: string;
}

export const updatePost: ToolDescriptor<UpdatePostInput, UpdatePostOutput> = {
  id: "featurebase.update_post",
  name: "Update Featurebase Post",
  description: "Update an existing post.",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: updatePostInput,
  output: updatePostOutput,
  handler: async (args, ctx) => {
    const updateData: Record<string, unknown> = {};
    if (args.title) updateData.title = args.title;
    if (args.content) updateData.content = args.content;
    if (args.statusId) updateData.statusId = args.statusId;
    if (args.tags) updateData.tags = args.tags;

    const res = await fbRequest<UpdatePostApi>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "put",
      `v2/posts/${encodeURIComponent(args.postId)}`,
      { json: updateData },
    );
    if (!res.ok) throw new Error(`Failed to update post: ${res.message}`);
    const post = res.data;
    const postData = {
      id: post.id,
      slug: post.slug,
      title: post.title,
      content: post.content || post.body || "",
      lastModified: post.lastModified || post.updatedAt || new Date().toISOString(),
    };
    return { post: postData, estimatedTokens: estimateTokens(postData) };
  },
};

const deletePostInput = z.object({ postId: safeId("Post ID to delete") });
const deletePostOutput = z.object({
  success: z.boolean(),
  postId: z.string(),
  estimatedTokens: z.number(),
});

type DeletePostInput = z.infer<typeof deletePostInput>;
type DeletePostOutput = z.infer<typeof deletePostOutput>;

export const deletePost: ToolDescriptor<DeletePostInput, DeletePostOutput> = {
  id: "featurebase.delete_post",
  name: "Delete Featurebase Post",
  description: "Delete a post.",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: deletePostInput,
  output: deletePostOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<{ success?: boolean }>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "delete",
      `v2/posts/${encodeURIComponent(args.postId)}`,
    );
    if (!res.ok) throw new Error(`Failed to delete post: ${res.message}`);
    const resultData = { success: true, postId: args.postId };
    return { ...resultData, estimatedTokens: estimateTokens(resultData) };
  },
};

// ── PATCH transport helper (appended; the locked `fbRequest` only carries POST/PUT
//    bodies, so the three PATCH-with-body endpoints — update_collection,
//    update_article, update_comment — issue PATCH via the same `activeFetch` seam
//    with identical X-API-Key auth + error mapping, preserving the source HTTP
//    method). JSON for collections/articles, form-encoded for comments. ───────────

async function fbPatch<T>(
  apiKey: string,
  path: string,
  opts: { json?: unknown; form?: Record<string, string | number | boolean | undefined> },
): Promise<FbResult<T>> {
  const headers: Record<string, string> = { "X-API-Key": apiKey };
  const init: RequestInit = { method: "PATCH", headers };

  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const fd = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) {
      if (v !== undefined) fd.append(k, String(v));
    }
    init.body = fd.toString();
  }

  const res = await activeFetch(`${FB_BASE}/${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, message: sanitizeErrorMessage(text || `HTTP ${res.status}`) };
  }
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: true, status: res.status, data };
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  CHANGELOG                                                                 ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const listChangelogInput = z.object({
  limit: z
    .number()
    .int()
    .min(1, "limit must be at least 1")
    .max(100, "limit cannot exceed 100")
    .optional()
    .describe("Number of changelog entries to return (1-100)"),
  cursor: safeOptional("Pagination cursor from previous response"),
  tags: z.array(z.string()).optional().describe("Filter by tag names"),
  q: safeOptional("Search query for title/content"),
});

const listChangelogOutput = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
      publishedAt: z.string(),
      updatedAt: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
  totalCount: z.number(),
  estimatedTokens: z.number(),
});

type ListChangelogInput = z.infer<typeof listChangelogInput>;
type ListChangelogOutput = z.infer<typeof listChangelogOutput>;

export const listChangelog: ToolDescriptor<ListChangelogInput, ListChangelogOutput> = {
  id: "featurebase.list_changelog",
  name: "List Featurebase Changelog Entries",
  description: "List changelog entries with filtering and pagination",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: listChangelogInput,
  output: listChangelogOutput,
  handler: async (args, ctx) => {
    const query: Query = { limit: args.limit ?? 10 };
    if (args.cursor) query.cursor = args.cursor;
    if (args.tags) query.tags = args.tags.join(",");
    if (args.q) query.q = args.q;

    const res = await fbRequest<{
      results?: Array<{
        id: string;
        title: string;
        content: string;
        publishedAt: string;
        updatedAt?: string;
        tags?: string[];
      }>;
      page?: number;
      totalResults?: number;
    }>(ctx.secrets.FEATUREBASE_API_KEY, "get", "v2/changelogs", { query });
    if (!res.ok) throw new Error(`FeatureBase API error: ${res.message}`);

    const entriesArray = res.data.results || [];
    return {
      entries: entriesArray.map((entry) => ({
        id: entry.id,
        title: entry.title,
        content: (entry.content || "").substring(0, 500),
        publishedAt: entry.publishedAt || new Date().toISOString(),
        updatedAt: entry.updatedAt,
        tags: entry.tags || [],
      })),
      nextCursor: null,
      totalCount: res.data.totalResults || entriesArray.length,
      estimatedTokens: estimateTokens(res.data),
    };
  },
};

const getChangelogInput = z.object({ changelogId: safeId("Changelog ID to retrieve") });

const getChangelogOutput = z.object({
  entry: z.object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    publishedAt: z.string(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  estimatedTokens: z.number(),
});

type GetChangelogInput = z.infer<typeof getChangelogInput>;
type GetChangelogOutput = z.infer<typeof getChangelogOutput>;

interface GetChangelogApi {
  id: string;
  title: string;
  content: string;
  publishedAt: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
}

export const getChangelog: ToolDescriptor<GetChangelogInput, GetChangelogOutput> = {
  id: "featurebase.get_changelog",
  name: "Get Featurebase Changelog Entry",
  description: "Get a single changelog entry by ID",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: getChangelogInput,
  output: getChangelogOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<GetChangelogApi>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "get",
      `v2/changelogs/${encodeURIComponent(args.changelogId)}`,
    );
    if (!res.ok) {
      throw new Error(
        res.status === 404
          ? `Changelog not found: ${args.changelogId}`
          : `Failed to get changelog: ${res.message}`,
      );
    }
    const entry = res.data;
    const entryData = {
      id: entry.id,
      title: entry.title,
      content: entry.content,
      publishedAt: entry.publishedAt,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      tags: entry.tags || [],
    };
    return { entry: entryData, estimatedTokens: estimateTokens(entryData) };
  },
};

const createChangelogInput = z.object({
  title: z
    .string()
    .min(1, "title is required")
    .max(255, "title cannot exceed 255 characters")
    .refine(validateNoControlChars, "Control characters not allowed")
    .refine(validateNoPathTraversal, "Path traversal not allowed")
    .refine(validateNoCommandInjection, "Invalid characters detected")
    .describe("Changelog title"),
  content: z.string().min(1, "content is required").describe("Changelog content (markdown supported)"),
  publishedAt: z.string().min(1, "publishedAt is required").describe("Publication date (ISO 8601 format)"),
  tags: z.array(z.string()).optional().describe("Optional tags"),
});

const createChangelogOutput = z.object({
  entry: z.object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    publishedAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  estimatedTokens: z.number(),
});

type CreateChangelogInput = z.infer<typeof createChangelogInput>;
type CreateChangelogOutput = z.infer<typeof createChangelogOutput>;

interface CreateChangelogApi {
  id: string;
  title: string;
  markdownContent?: string;
  content?: string;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
}

export const createChangelog: ToolDescriptor<CreateChangelogInput, CreateChangelogOutput> = {
  id: "featurebase.create_changelog",
  name: "Create Featurebase Changelog Entry",
  description: "Create a new changelog entry",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: createChangelogInput,
  output: createChangelogOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<CreateChangelogApi>(ctx.secrets.FEATUREBASE_API_KEY, "post", "v2/changelogs", {
      json: {
        title: args.title,
        markdownContent: args.content, // API field is 'markdownContent', not 'content'
        publishedAt: args.publishedAt,
        ...(args.tags && { tags: args.tags }),
      },
    });
    if (!res.ok) throw new Error(`Failed to create changelog: ${res.message}`);
    const entry = res.data;
    const entryData = {
      id: entry.id,
      title: entry.title,
      content: entry.markdownContent || entry.content || "",
      publishedAt: entry.publishedAt,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    return { entry: entryData, estimatedTokens: estimateTokens(entryData) };
  },
};

const updateChangelogInput = z.object({
  changelogId: safeId("Changelog ID to update"),
  title: z
    .string()
    .max(255, "title cannot exceed 255 characters")
    .refine(validateNoControlChars, "Control characters not allowed")
    .optional()
    .describe("Changelog title"),
  content: z.string().optional().describe("Changelog content (markdown supported)"),
  publishedAt: z.string().optional().describe("Publication date (ISO 8601 format)"),
  tags: z.array(z.string()).optional().describe("Tags"),
});

const updateChangelogOutput = z.object({
  entry: z.object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    publishedAt: z.string(),
    updatedAt: z.string(),
  }),
  estimatedTokens: z.number(),
});

type UpdateChangelogInput = z.infer<typeof updateChangelogInput>;
type UpdateChangelogOutput = z.infer<typeof updateChangelogOutput>;

interface UpdateChangelogApi {
  id: string;
  title: string;
  content: string;
  publishedAt: string;
  updatedAt: string;
}

export const updateChangelog: ToolDescriptor<UpdateChangelogInput, UpdateChangelogOutput> = {
  id: "featurebase.update_changelog",
  name: "Update Featurebase Changelog Entry",
  description: "Update an existing changelog entry",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: updateChangelogInput,
  output: updateChangelogOutput,
  handler: async (args, ctx) => {
    const updateData: Record<string, unknown> = {};
    if (args.title) updateData.title = args.title;
    if (args.content) updateData.content = args.content;
    if (args.publishedAt) updateData.publishedAt = args.publishedAt;
    if (args.tags) updateData.tags = args.tags;

    const res = await fbRequest<UpdateChangelogApi>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "put",
      `v2/changelogs/${encodeURIComponent(args.changelogId)}`,
      { json: updateData },
    );
    if (!res.ok) throw new Error(`Failed to update changelog: ${res.message}`);
    const entry = res.data;
    const entryData = {
      id: entry.id,
      title: entry.title,
      content: entry.content,
      publishedAt: entry.publishedAt,
      updatedAt: entry.updatedAt,
    };
    return { entry: entryData, estimatedTokens: estimateTokens(entryData) };
  },
};

const deleteChangelogInput = z.object({ changelogId: safeId("Changelog ID to delete") });
const deleteChangelogOutput = z.object({
  success: z.boolean(),
  changelogId: z.string(),
  estimatedTokens: z.number(),
});

type DeleteChangelogInput = z.infer<typeof deleteChangelogInput>;
type DeleteChangelogOutput = z.infer<typeof deleteChangelogOutput>;

export const deleteChangelog: ToolDescriptor<DeleteChangelogInput, DeleteChangelogOutput> = {
  id: "featurebase.delete_changelog",
  name: "Delete Featurebase Changelog Entry",
  description: "Delete a changelog entry",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: deleteChangelogInput,
  output: deleteChangelogOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<{ success?: boolean }>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "delete",
      `v2/changelogs/${encodeURIComponent(args.changelogId)}`,
    );
    if (!res.ok) throw new Error(`Failed to delete changelog: ${res.message}`);
    const resultData = { success: true, changelogId: args.changelogId };
    return { ...resultData, estimatedTokens: estimateTokens(resultData) };
  },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  COLLECTIONS                                                               ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const listCollectionsInput = z.object({
  limit: z
    .number()
    .int()
    .min(1, "limit must be at least 1")
    .max(100, "limit cannot exceed 100")
    .optional()
    .describe("Number of collections to return (1-100)"),
  cursor: safeOptional("Pagination cursor from previous response"),
  parentId: safeOptional("Filter by parent collection ID (omit for top-level collections)"),
});

const listCollectionsOutput = z.object({
  collections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable().optional(),
      slug: z.string(),
      parentId: z.string().nullable(),
      helpCenterId: z.string(),
      articleCount: z.number(),
      order: z.number().nullable(),
      path: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
  totalCount: z.number(),
  estimatedTokens: z.number(),
});

type ListCollectionsInput = z.infer<typeof listCollectionsInput>;
type ListCollectionsOutput = z.infer<typeof listCollectionsOutput>;

export const listCollections: ToolDescriptor<ListCollectionsInput, ListCollectionsOutput> = {
  id: "featurebase.list_collections",
  name: "List Featurebase Collections",
  description: "List help center collections with optional filtering by parentId and pagination",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: listCollectionsInput,
  output: listCollectionsOutput,
  handler: async (args, ctx) => {
    const query: Query = { limit: args.limit ?? 20 };
    if (args.cursor) query.cursor = args.cursor;
    if (args.parentId) query.parentId = args.parentId;

    const res = await fbRequest<{
      object?: string;
      data?: Array<{
        object?: string;
        id: string;
        name: string;
        description?: string | null;
        slug: string;
        parentId: string | null;
        helpCenterId: string;
        articleCount: number;
        order: number;
        path: string;
        createdAt?: string;
        updatedAt?: string;
      }>;
      nextCursor?: string | null;
    }>(ctx.secrets.FEATUREBASE_API_KEY, "get", "v2/help_center/collections", { query });
    if (!res.ok) throw new Error(`FeatureBase API error: ${res.message}`);

    const collectionsArray = res.data.data || [];
    return {
      collections: collectionsArray.map((collection) => ({
        id: collection.id,
        name: collection.name,
        description: collection.description ?? null,
        slug: collection.slug,
        parentId: collection.parentId,
        helpCenterId: collection.helpCenterId,
        articleCount: collection.articleCount,
        order: collection.order ?? null,
        path: collection.path,
      })),
      nextCursor: res.data.nextCursor ?? null,
      totalCount: collectionsArray.length,
      estimatedTokens: estimateTokens(res.data),
    };
  },
};

const createCollectionInput = z.object({
  name: z
    .string()
    .min(1, "name is required")
    .max(255, "name cannot exceed 255 characters")
    .refine(validateNoControlChars, "Control characters not allowed")
    .refine(validateNoPathTraversal, "Path traversal not allowed")
    .refine(validateNoCommandInjection, "Invalid characters detected")
    .describe("Collection name"),
  helpCenterId: safeId('Help center ID (use "8b35wrfkj8m35dg3" for Praetorian)'),
  parentId: safeOptional("Parent collection ID for nesting (omit for top-level)"),
  description: safeOptional("Collection description"),
});

const createCollectionOutput = z.object({
  collection: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    slug: z.string(),
    parentId: z.string().nullable(),
    helpCenterId: z.string(),
    articleCount: z.number(),
    order: z.number(),
    path: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  estimatedTokens: z.number(),
});

type CreateCollectionInput = z.infer<typeof createCollectionInput>;
type CreateCollectionOutput = z.infer<typeof createCollectionOutput>;

interface CreateCollectionApi {
  object?: string;
  id: string;
  name: string;
  description?: string | null;
  slug: string;
  parentId: string | null;
  helpCenterId: string;
  articleCount: number;
  order: number;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export const createCollection: ToolDescriptor<CreateCollectionInput, CreateCollectionOutput> = {
  id: "featurebase.create_collection",
  name: "Create Featurebase Collection",
  description: "Create a new help center collection (optionally nested under a parent collection)",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: createCollectionInput,
  output: createCollectionOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<CreateCollectionApi>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "post",
      "v2/help_center/collections",
      {
        json: {
          name: args.name,
          helpCenterId: args.helpCenterId,
          ...(args.parentId && { parentId: args.parentId }),
          ...(args.description && { description: args.description }),
        },
      },
    );
    if (!res.ok) throw new Error(`Failed to create collection: ${res.message}`);
    const collection = res.data;
    const collectionData = {
      id: collection.id,
      name: collection.name,
      description: collection.description ?? null,
      slug: collection.slug,
      parentId: collection.parentId,
      helpCenterId: collection.helpCenterId,
      articleCount: collection.articleCount,
      order: collection.order,
      path: collection.path,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
    };
    return { collection: collectionData, estimatedTokens: estimateTokens(collectionData) };
  },
};

const updateCollectionInput = z.object({
  collectionId: safeId("Collection ID to update (used as path parameter)"),
  name: safeOptional("Updated collection name"),
  description: safeOptional("Updated collection description"),
  parentId: safeOptional("Updated parent collection ID (for nesting)"),
});

const updateCollectionOutput = z.object({
  collection: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    slug: z.string(),
    parentId: z.string().nullable(),
    helpCenterId: z.string(),
    articleCount: z.number(),
    order: z.number().nullable(),
    path: z.string(),
  }),
  estimatedTokens: z.number(),
});

type UpdateCollectionInput = z.infer<typeof updateCollectionInput>;
type UpdateCollectionOutput = z.infer<typeof updateCollectionOutput>;

interface UpdateCollectionApi {
  object?: string;
  id: string;
  name: string;
  description?: string | null;
  slug: string;
  parentId: string | null;
  helpCenterId: string;
  articleCount: number;
  order: number | null;
  path: string;
  createdAt?: string;
  updatedAt?: string;
}

export const updateCollection: ToolDescriptor<UpdateCollectionInput, UpdateCollectionOutput> = {
  id: "featurebase.update_collection",
  name: "Update Featurebase Collection",
  description: "Update an existing help center collection",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: updateCollectionInput,
  output: updateCollectionOutput,
  handler: async (args, ctx) => {
    const res = await fbPatch<UpdateCollectionApi>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "v2/help_center/collections/" + encodeURIComponent(args.collectionId),
      {
        json: {
          ...(args.name !== undefined && { name: args.name }),
          ...(args.description !== undefined && { description: args.description }),
          ...(args.parentId !== undefined && { parentId: args.parentId }),
        },
      },
    );
    if (!res.ok) throw new Error(`Failed to update collection: ${res.message}`);
    const collection = res.data;
    const collectionData = {
      id: collection.id,
      name: collection.name,
      description: collection.description ?? null,
      slug: collection.slug,
      parentId: collection.parentId,
      helpCenterId: collection.helpCenterId,
      articleCount: collection.articleCount,
      order: collection.order ?? null,
      path: collection.path,
    };
    return { collection: collectionData, estimatedTokens: estimateTokens(collectionData) };
  },
};

const deleteCollectionInput = z.object({ collectionId: safeId("Collection ID to delete") });
const deleteCollectionOutput = z.object({
  success: z.boolean(),
  collectionId: z.string(),
  estimatedTokens: z.number(),
});

type DeleteCollectionInput = z.infer<typeof deleteCollectionInput>;
type DeleteCollectionOutput = z.infer<typeof deleteCollectionOutput>;

export const deleteCollection: ToolDescriptor<DeleteCollectionInput, DeleteCollectionOutput> = {
  id: "featurebase.delete_collection",
  name: "Delete Featurebase Collection",
  description: "Delete a help center collection",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: deleteCollectionInput,
  output: deleteCollectionOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<{ success?: boolean }>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "delete",
      "v2/help_center/collections/" + encodeURIComponent(args.collectionId),
    );
    if (!res.ok) throw new Error(`Failed to delete collection: ${res.message}`);
    const resultData = { success: true, collectionId: args.collectionId };
    return { ...resultData, estimatedTokens: estimateTokens(resultData) };
  },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ARTICLES                                                                  ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const listArticlesInput = z.object({
  limit: z
    .number()
    .int()
    .min(1, "limit must be at least 1")
    .max(100, "limit cannot exceed 100")
    .optional()
    .describe("Number of articles to return (1-100)"),
  cursor: safeOptional("Pagination cursor from previous response"),
  category: safeOptional("Filter by category"),
  q: safeOptional("Search query for title/content"),
});

const listArticlesOutput = z.object({
  articles: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
      category: z.string(),
      slug: z.string().optional(),
      publishedAt: z.string(),
      updatedAt: z.string().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
  totalCount: z.number(),
  estimatedTokens: z.number(),
});

type ListArticlesInput = z.infer<typeof listArticlesInput>;
type ListArticlesOutput = z.infer<typeof listArticlesOutput>;

interface ArticleListNode {
  id: string;
  title: string;
  body: string;
  description?: string;
  category?: string;
  slug?: string;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const listArticles: ToolDescriptor<ListArticlesInput, ListArticlesOutput> = {
  id: "featurebase.list_articles",
  name: "List Featurebase Articles",
  description: "List articles with filtering and pagination",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: listArticlesInput,
  output: listArticlesOutput,
  handler: async (args, ctx) => {
    const query: Query = { limit: args.limit ?? 10 };
    if (args.cursor) query.cursor = args.cursor;
    if (args.category) query.category = args.category;
    if (args.q) query.q = args.q;

    const res = await fbRequest<{
      data?: ArticleListNode[];
      results?: ArticleListNode[];
      page?: number;
      totalResults?: number;
    }>(ctx.secrets.FEATUREBASE_API_KEY, "get", "v2/help_center/articles", { query });
    if (!res.ok) throw new Error(`FeatureBase API error: ${res.message}`);

    const articlesArray = res.data.data || res.data.results || [];
    return {
      articles: articlesArray.map((article) => ({
        id: article.id,
        title: article.title,
        content: (article.body || "").substring(0, 500),
        category: article.category || "",
        slug: article.slug,
        publishedAt: article.publishedAt || article.createdAt || new Date().toISOString(),
        updatedAt: article.updatedAt || new Date().toISOString(),
      })),
      nextCursor: null,
      totalCount: res.data.totalResults || articlesArray.length,
      estimatedTokens: estimateTokens(res.data),
    };
  },
};

const getArticleInput = z.object({ articleId: safeId("Article ID to retrieve") });

const getArticleOutput = z.object({
  article: z.object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    category: z.string(),
    slug: z.string().optional(),
    publishedAt: z.string(),
    updatedAt: z.string().optional(),
  }),
  estimatedTokens: z.number(),
});

type GetArticleInput = z.infer<typeof getArticleInput>;
type GetArticleOutput = z.infer<typeof getArticleOutput>;

interface GetArticleApi {
  id: string;
  title: string;
  content?: string;
  body?: string;
  category?: string;
  slug?: string;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export const getArticle: ToolDescriptor<GetArticleInput, GetArticleOutput> = {
  id: "featurebase.get_article",
  name: "Get Featurebase Article",
  description: "Get a single article by ID",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: getArticleInput,
  output: getArticleOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<GetArticleApi>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "get",
      `v2/help_center/articles/${encodeURIComponent(args.articleId)}`,
    );
    if (!res.ok) {
      throw new Error(
        res.status === 404
          ? `Article not found: ${args.articleId}`
          : `Failed to get article: ${res.message}`,
      );
    }
    const article = res.data;
    const articleData = {
      id: article.id,
      title: article.title,
      content: article.body || article.content || "",
      category: article.category || "",
      slug: article.slug,
      publishedAt: article.publishedAt || article.createdAt || new Date().toISOString(),
      updatedAt: article.updatedAt,
    };
    return { article: articleData, estimatedTokens: estimateTokens(articleData) };
  },
};

const createArticleInput = z.object({
  title: z
    .string()
    .min(1, "title is required")
    .max(255, "title cannot exceed 255 characters")
    .refine(validateNoControlChars, "Control characters not allowed")
    .refine(validateNoPathTraversal, "Path traversal not allowed")
    .refine(validateNoCommandInjection, "Invalid characters detected")
    .describe("Article title"),
  content: z.string().min(1, "content is required").describe("Article content (markdown supported)"),
  category: z
    .string()
    .min(1, "category is required")
    .refine(validateNoControlChars, "Control characters not allowed")
    .refine(validateNoPathTraversal, "Path traversal not allowed")
    .refine(validateNoCommandInjection, "Invalid characters detected")
    .describe("Article category"),
  slug: z
    .string()
    .refine((val) => !val || validateNoControlChars(val), "Control characters not allowed")
    .refine((val) => !val || validateNoPathTraversal(val), "Path traversal not allowed")
    .refine((val) => !val || validateNoCommandInjection(val), "Invalid characters detected")
    .optional()
    .describe("Optional URL slug"),
  publishedAt: z.string().min(1, "publishedAt is required").describe("Publication date (ISO 8601 format)"),
  tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
  collectionId: safeOptional("Collection ID to place this article in (from list-collections)"),
});

const createArticleOutput = z.object({
  article: z.object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    category: z.string(),
    slug: z.string().optional(),
    publishedAt: z.string(),
    updatedAt: z.string(),
    tags: z.array(z.string()).optional(),
  }),
  estimatedTokens: z.number(),
});

type CreateArticleInput = z.infer<typeof createArticleInput>;
type CreateArticleOutput = z.infer<typeof createArticleOutput>;

interface CreateArticleApi {
  id: string;
  title: string;
  content?: string;
  body?: string;
  category?: string;
  slug?: string;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
}

export const createArticle: ToolDescriptor<CreateArticleInput, CreateArticleOutput> = {
  id: "featurebase.create_article",
  name: "Create Featurebase Article",
  description: "Create a new article",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: createArticleInput,
  output: createArticleOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<CreateArticleApi>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "post",
      "v2/help_center/articles",
      {
        json: {
          title: args.title,
          body: args.content, // API field is 'body', not 'content'
          category: args.category, // Kept for backwards compatibility, but ignored by API
          ...(args.slug && { slug: args.slug }),
          ...(args.publishedAt && { publishedAt: args.publishedAt }),
          ...(args.tags && { tags: args.tags }),
          ...(args.collectionId && { collectionId: args.collectionId }),
        },
      },
    );
    if (!res.ok) throw new Error(`Failed to create article: ${res.message}`);
    const article = res.data;
    const articleData = {
      id: article.id,
      title: article.title,
      content: article.body || article.content || "",
      category: article.category || args.category || "",
      slug: article.slug,
      publishedAt: article.publishedAt || article.createdAt || new Date().toISOString(),
      updatedAt: article.updatedAt || new Date().toISOString(),
      tags: article.tags || args.tags,
    };
    return { article: articleData, estimatedTokens: estimateTokens(articleData) };
  },
};

const updateArticleInput = z.object({
  articleId: safeId("Article ID to update"),
  title: z
    .string()
    .refine((val) => !val || validateNoControlChars(val), "Control characters not allowed")
    .optional()
    .describe("Updated title"),
  content: z.string().optional().describe("Updated content"),
  category: z
    .string()
    .refine((val) => !val || validateNoControlChars(val), "Control characters not allowed")
    .optional()
    .describe("Updated category"),
  slug: z
    .string()
    .refine((val) => !val || validateNoControlChars(val), "Control characters not allowed")
    .optional()
    .describe("Updated slug"),
  collectionId: safeOptional("Collection ID to move this article to (from list-collections)"),
});

const updateArticleOutput = z.object({
  article: z.object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    category: z.string(),
    slug: z.string().optional(),
    publishedAt: z.string(),
    updatedAt: z.string(),
  }),
  estimatedTokens: z.number(),
});

type UpdateArticleInput = z.infer<typeof updateArticleInput>;
type UpdateArticleOutput = z.infer<typeof updateArticleOutput>;

interface UpdateArticleApi {
  id: string;
  title: string;
  content?: string;
  body?: string;
  category?: string;
  slug?: string;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export const updateArticle: ToolDescriptor<UpdateArticleInput, UpdateArticleOutput> = {
  id: "featurebase.update_article",
  name: "Update Featurebase Article",
  description: "Update an article",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: updateArticleInput,
  output: updateArticleOutput,
  handler: async (args, ctx) => {
    const res = await fbPatch<UpdateArticleApi>(
      ctx.secrets.FEATUREBASE_API_KEY,
      `v2/help_center/articles/${encodeURIComponent(args.articleId)}`,
      {
        json: {
          ...(args.title && { title: args.title }),
          ...(args.content && { body: args.content }), // API uses 'body' not 'content'
          ...(args.slug && { slug: args.slug }),
          ...(args.collectionId && { collectionId: args.collectionId }),
        },
      },
    );
    if (!res.ok) throw new Error(`Failed to update article: ${res.message}`);
    const article = res.data;
    const articleData = {
      id: article.id,
      title: article.title,
      content: article.body || article.content || "",
      category: article.category || args.category || "",
      slug: article.slug,
      publishedAt: article.publishedAt || article.createdAt || article.updatedAt || new Date().toISOString(),
      updatedAt: article.updatedAt || new Date().toISOString(),
    };
    return { article: articleData, estimatedTokens: estimateTokens(articleData) };
  },
};

const deleteArticleInput = z.object({ articleId: safeId("Article ID to delete") });
const deleteArticleOutput = z.object({
  success: z.boolean(),
  articleId: z.string(),
  estimatedTokens: z.number(),
});

type DeleteArticleInput = z.infer<typeof deleteArticleInput>;
type DeleteArticleOutput = z.infer<typeof deleteArticleOutput>;

export const deleteArticle: ToolDescriptor<DeleteArticleInput, DeleteArticleOutput> = {
  id: "featurebase.delete_article",
  name: "Delete Featurebase Article",
  description: "Delete an article",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: deleteArticleInput,
  output: deleteArticleOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<{ success?: boolean }>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "delete",
      `v2/help_center/articles/${encodeURIComponent(args.articleId)}`,
    );
    if (!res.ok) throw new Error(`Failed to delete article: ${res.message}`);
    const resultData = { success: true, articleId: args.articleId };
    return { ...resultData, estimatedTokens: estimateTokens(resultData) };
  },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  COMMENTS  (POST/PUT/PATCH use application/x-www-form-urlencoded)          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const listCommentsInput = z
  .object({
    submissionId: safeOptional("Filter by post ID"),
    changelogId: safeOptional("Filter by changelog ID"),
    limit: z
      .number()
      .int()
      .min(1, "limit must be at least 1")
      .max(100, "limit cannot exceed 100")
      .optional()
      .describe("Number of comments to return (1-100)"),
    page: z.number().int().min(1, "page must be at least 1").optional().describe("Page number for pagination"),
    sortBy: z.enum(["newest", "oldest", "popular"]).optional().describe("Sort order for comments"),
    includePrivate: z.boolean().optional().describe("Include private comments (admin only)"),
    includeDeleted: z.boolean().optional().describe("Include soft-deleted comments"),
  })
  .refine((data) => data.submissionId || data.changelogId, {
    message: "Either submissionId or changelogId is required",
  });

const listCommentsOutput = z.object({
  comments: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      createdAt: z.string(),
      author: z.object({
        id: z.string(),
        name: z.string(),
      }),
      parentCommentId: z.string().nullable(),
      isPrivate: z.boolean(),
      isPinned: z.boolean(),
      upvotes: z.number(),
      replyCount: z.number().optional(),
    }),
  ),
  page: z.number(),
  totalPages: z.number(),
  totalResults: z.number(),
  estimatedTokens: z.number(),
});

type ListCommentsInput = z.infer<typeof listCommentsInput>;
type ListCommentsOutput = z.infer<typeof listCommentsOutput>;

interface CommentListNode {
  id: string;
  content: string;
  createdAt: string;
  author: { id: string; name: string; email?: string; profilePicture?: string };
  parentCommentId: string | null;
  isPrivate: boolean;
  isPinned: boolean;
  upvotes: number;
  downvotes?: number;
  score?: number;
  replyCount?: number;
}

export const listComments: ToolDescriptor<ListCommentsInput, ListCommentsOutput> = {
  id: "featurebase.list_comments",
  name: "List Featurebase Comments",
  description: "List comments for a post or changelog with filtering and pagination",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: listCommentsInput,
  output: listCommentsOutput,
  handler: async (args, ctx) => {
    const limit = args.limit ?? 10;
    const page = args.page ?? 1;
    const sortBy = args.sortBy ?? "newest";

    // Build query string exactly as the source does (GET uses query params).
    const queryParams: string[] = [];
    if (args.submissionId) queryParams.push(`submissionId=${encodeURIComponent(args.submissionId)}`);
    if (args.changelogId) queryParams.push(`changelogId=${encodeURIComponent(args.changelogId)}`);
    queryParams.push(`limit=${limit}`);
    queryParams.push(`page=${page}`);
    queryParams.push(`sortBy=${sortBy}`);
    if (args.includePrivate !== undefined) queryParams.push(`includePrivate=${args.includePrivate}`);
    if (args.includeDeleted !== undefined) queryParams.push(`includeDeleted=${args.includeDeleted}`);
    const queryString = queryParams.join("&");

    const res = await fbRequest<{
      comments: CommentListNode[];
      page: number;
      totalPages: number;
      totalResults: number;
    }>(ctx.secrets.FEATUREBASE_API_KEY, "get", `v2/comment?${queryString}`);
    if (!res.ok) throw new Error(`FeatureBase Comments API error: ${res.message}`);

    return {
      comments: res.data.comments.map((comment) => ({
        id: comment.id,
        content: (comment.content || "").substring(0, 500),
        createdAt: comment.createdAt,
        author: {
          id: comment.author.id,
          name: comment.author.name,
        },
        parentCommentId: comment.parentCommentId,
        isPrivate: comment.isPrivate,
        isPinned: comment.isPinned,
        upvotes: comment.upvotes,
        replyCount: comment.replyCount,
      })),
      page: res.data.page || 1,
      totalPages: res.data.totalPages || 1,
      totalResults: res.data.totalResults || res.data.comments.length,
      estimatedTokens: estimateTokens(res.data),
    };
  },
};

const createCommentInput = z
  .object({
    submissionId: safeOptional("Post ID to comment on"),
    changelogId: safeOptional("Changelog ID to comment on"),
    content: z
      .string()
      .min(1)
      .max(10000)
      .refine((val) => validateNoControlChars(val), "Control characters not allowed")
      .describe("Comment content"),
    parentCommentId: safeOptional("Parent comment ID for threaded replies"),
    isPrivate: z.boolean().optional().describe("Whether the comment is private (admin-only)"),
  })
  .refine((data) => data.submissionId || data.changelogId, {
    message: "Either submissionId or changelogId is required",
  });

const createCommentOutput = z.object({
  id: z.string(),
  submissionId: z.string().optional(),
  changelogId: z.string().optional(),
  content: z.string(),
  parentCommentId: z.string().optional(),
  isPrivate: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
  }),
  upvotes: z.number(),
  downvotes: z.number(),
  score: z.number(),
  estimatedTokens: z.number(),
});

type CreateCommentInput = z.infer<typeof createCommentInput>;
type CreateCommentOutput = z.infer<typeof createCommentOutput>;

interface CommentApi {
  id: string;
  submissionId?: string;
  changelogId?: string;
  content: string;
  parentCommentId?: string;
  isPrivate: boolean;
  isPinned?: boolean;
  createdAt: string;
  updatedAt: string;
  author: { id: string; name: string; email: string };
  upvotes: number;
  downvotes: number;
  score: number;
}

export const createComment: ToolDescriptor<CreateCommentInput, CreateCommentOutput> = {
  id: "featurebase.create_comment",
  name: "Create Featurebase Comment",
  description:
    "Create a new comment on a post or changelog with support for threaded replies and private comments",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: createCommentInput,
  output: createCommentOutput,
  handler: async (args, ctx) => {
    const form: Record<string, string | number | boolean | undefined> = {
      content: args.content,
    };
    if (args.submissionId) form.submissionId = args.submissionId;
    if (args.changelogId) form.changelogId = args.changelogId;
    if (args.parentCommentId) form.parentCommentId = args.parentCommentId;
    if (args.isPrivate !== undefined) form.isPrivate = args.isPrivate;

    const res = await fbRequest<CommentApi>(ctx.secrets.FEATUREBASE_API_KEY, "post", "v2/comment", { form });
    if (!res.ok) throw new Error(`Failed to create comment: ${res.message}`);

    const comment = res.data;
    return {
      id: comment.id,
      submissionId: comment.submissionId,
      changelogId: comment.changelogId,
      content: comment.content,
      parentCommentId: comment.parentCommentId,
      isPrivate: comment.isPrivate,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: comment.author,
      upvotes: comment.upvotes,
      downvotes: comment.downvotes,
      score: comment.score,
      estimatedTokens: estimateTokens(comment),
    };
  },
};

const updateCommentInput = z.object({
  commentId: safeId("Comment ID to update"),
  content: z
    .string()
    .max(10000, "content must be at most 10000 characters")
    .refine((val) => validateNoControlChars(val), "Control characters not allowed")
    .optional()
    .describe("Updated comment content"),
  isPinned: z.boolean().optional().describe("Whether the comment is pinned"),
  isPrivate: z.boolean().optional().describe("Whether the comment is private"),
});

const updateCommentOutput = z.object({
  id: z.string(),
  submissionId: z.string().optional(),
  changelogId: z.string().optional(),
  content: z.string(),
  parentCommentId: z.string().optional(),
  isPrivate: z.boolean(),
  isPinned: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
  }),
  upvotes: z.number(),
  downvotes: z.number(),
  score: z.number(),
  estimatedTokens: z.number(),
});

type UpdateCommentInput = z.infer<typeof updateCommentInput>;
type UpdateCommentOutput = z.infer<typeof updateCommentOutput>;

export const updateComment: ToolDescriptor<UpdateCommentInput, UpdateCommentOutput> = {
  id: "featurebase.update_comment",
  name: "Update Featurebase Comment",
  description: "Update an existing comment's content, pin status, or privacy settings",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: updateCommentInput,
  output: updateCommentOutput,
  handler: async (args, ctx) => {
    const form: Record<string, string | number | boolean | undefined> = {};
    if (args.content !== undefined) form.content = args.content;
    if (args.isPinned !== undefined) form.isPinned = args.isPinned;
    if (args.isPrivate !== undefined) form.isPrivate = args.isPrivate;

    const res = await fbPatch<CommentApi>(
      ctx.secrets.FEATUREBASE_API_KEY,
      `v2/comment/${encodeURIComponent(args.commentId)}`,
      { form },
    );
    if (!res.ok) throw new Error(`Failed to update comment: ${res.message}`);

    const comment = res.data;
    return {
      id: comment.id,
      submissionId: comment.submissionId,
      changelogId: comment.changelogId,
      content: comment.content,
      parentCommentId: comment.parentCommentId,
      isPrivate: comment.isPrivate,
      isPinned: comment.isPinned,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: comment.author,
      upvotes: comment.upvotes,
      downvotes: comment.downvotes,
      score: comment.score,
      estimatedTokens: estimateTokens(comment),
    };
  },
};

const deleteCommentInput = z.object({ commentId: safeId("Comment ID to delete") });
const deleteCommentOutput = z.object({
  success: z.boolean(),
  commentId: z.string(),
  deletionType: z.enum(["hard", "soft"]),
  estimatedTokens: z.number(),
});

type DeleteCommentInput = z.infer<typeof deleteCommentInput>;
type DeleteCommentOutput = z.infer<typeof deleteCommentOutput>;

export const deleteComment: ToolDescriptor<DeleteCommentInput, DeleteCommentOutput> = {
  id: "featurebase.delete_comment",
  name: "Delete Featurebase Comment",
  description: "Delete a comment from a post or changelog (soft-deletes if replies exist)",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: deleteCommentInput,
  output: deleteCommentOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<{ deletionType?: string }>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "delete",
      `v2/comment/${encodeURIComponent(args.commentId)}`,
    );
    if (!res.ok) throw new Error(`Failed to delete comment: ${res.message}`);
    const deletionType = res.data.deletionType === "soft" ? "soft" : "hard";
    const resultData = { success: true, commentId: args.commentId, deletionType: deletionType as "hard" | "soft" };
    return { ...resultData, estimatedTokens: estimateTokens({ success: true, commentId: args.commentId, deletionType }) };
  },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  USERS                                                                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const identifyUserInput = z
  .object({
    email: z.string().email().optional().describe("User email address"),
    userId: safeOptional("User ID"),
    name: z
      .string()
      .max(255, "name cannot exceed 255 characters")
      .refine((val) => validateNoControlChars(val), "Control characters not allowed")
      .refine((val) => validateNoPathTraversal(val), "Path traversal not allowed")
      .refine((val) => validateNoCommandInjection(val), "Invalid characters detected")
      .optional()
      .describe("User name"),
    customFields: z.record(z.string(), z.any()).optional().describe("Custom user fields"),
    companies: z
      .array(
        z.object({
          id: z.string().min(1, "company id is required"),
          name: z.string().min(1, "company name is required"),
          monthlySpend: z.number().optional(),
          customFields: z.record(z.string(), z.any()).optional(),
        }),
      )
      .optional()
      .describe("Associated companies"),
  })
  .refine((data) => data.email || data.userId, {
    message: "Either email or userId is required",
  });

const identifyUserOutput = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().optional(),
    name: z.string().optional(),
    customFields: z.record(z.string(), z.any()).optional(),
    companies: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          monthlySpend: z.number().optional(),
          customFields: z.record(z.string(), z.any()).optional(),
        }),
      )
      .optional(),
  }),
  estimatedTokens: z.number(),
});

type IdentifyUserInput = z.infer<typeof identifyUserInput>;
type IdentifyUserOutput = z.infer<typeof identifyUserOutput>;

interface IdentifyUserApi {
  id?: string;
  email?: string;
  userId?: string;
  name?: string;
  customFields?: Record<string, unknown>;
  companies?: Array<{
    id: string;
    name: string;
    monthlySpend?: number;
    customFields?: Record<string, unknown>;
  }>;
  createdAt?: string;
  updatedAt?: string;
}

export const identifyUser: ToolDescriptor<IdentifyUserInput, IdentifyUserOutput> = {
  id: "featurebase.identify_user",
  name: "Identify Featurebase User",
  description: "Identify or update a user in FeatureBase (upsert)",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: identifyUserInput,
  output: identifyUserOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<IdentifyUserApi>(ctx.secrets.FEATUREBASE_API_KEY, "post", "v2/contacts", {
      json: {
        ...(args.email && { email: args.email }),
        ...(args.userId && { userId: args.userId }),
        ...(args.name && { name: args.name }),
        ...(args.customFields && { customFields: args.customFields }),
        ...(args.companies && { companies: args.companies }),
      },
    });
    if (!res.ok) throw new Error(`Failed to identify user: ${res.message}`);

    const contact = res.data;
    const userData = {
      id: contact.id || contact.userId || "",
      email: contact.email,
      name: contact.name,
      customFields: contact.customFields,
      companies: contact.companies,
    };
    return { user: userData, estimatedTokens: estimateTokens(userData) };
  },
};

const getUserInput = z
  .object({
    email: safeOptional("User email address"),
    userId: safeOptional("User ID from your system"),
  })
  .refine((data) => data.email || data.userId, {
    message: "Either email or userId is required",
  });

const getUserOutput = z.object({
  user: z.object({
    email: z.string(),
    userId: z.string().optional(),
    name: z.string().optional(),
    customFields: z.record(z.any()).optional(),
    companies: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          monthlySpend: z.number().optional(),
          customFields: z.record(z.any()).optional(),
        }),
      )
      .optional(),
    createdAt: z.string().optional(),
    lastActivity: z.string().optional(),
    totalPosts: z.number().optional(),
    totalComments: z.number().optional(),
    totalUpvotes: z.number().optional(),
  }),
  estimatedTokens: z.number(),
});

type GetUserInput = z.infer<typeof getUserInput>;
type GetUserOutput = z.infer<typeof getUserOutput>;

interface GetUserApi {
  user: {
    email: string;
    userId?: string;
    name?: string;
    customFields?: Record<string, unknown>;
    companies?: Array<{
      id: string;
      name: string;
      monthlySpend?: number;
      customFields?: Record<string, unknown>;
    }>;
    createdAt?: string;
    lastActivity?: string;
    totalPosts?: number;
    totalComments?: number;
    totalUpvotes?: number;
  };
}

export const getUser: ToolDescriptor<GetUserInput, GetUserOutput> = {
  id: "featurebase.get_user",
  name: "Get Featurebase User",
  description: "Get a user by email or userId",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: getUserInput,
  output: getUserOutput,
  handler: async (args, ctx) => {
    const params = new URLSearchParams();
    if (args.email) params.append("email", args.email);
    if (args.userId) params.append("userId", args.userId);

    const res = await fbRequest<GetUserApi>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "get",
      `v2/organization/identifyUser?${params.toString()}`,
    );
    if (!res.ok) {
      throw new Error(
        res.status === 404
          ? `User not found: ${args.email || args.userId}`
          : `Failed to get user: ${res.message}`,
      );
    }
    const userData = {
      email: res.data.user.email,
      userId: res.data.user.userId,
      name: res.data.user.name,
      customFields: res.data.user.customFields || {},
      companies: res.data.user.companies || [],
      createdAt: res.data.user.createdAt,
      lastActivity: res.data.user.lastActivity,
      totalPosts: res.data.user.totalPosts || 0,
      totalComments: res.data.user.totalComments || 0,
      totalUpvotes: res.data.user.totalUpvotes || 0,
    };
    return { user: userData, estimatedTokens: estimateTokens(userData) };
  },
};

const listUsersInput = z.object({
  cursor: z
    .string()
    .refine((val) => val === undefined || validateNoControlChars(val), "Control characters not allowed")
    .refine((val) => val === undefined || validateNoPathTraversal(val), "Path traversal not allowed")
    .refine((val) => val === undefined || validateNoCommandInjection(val), "Command injection not allowed")
    .optional()
    .describe("Pagination cursor from previous response"),
  limit: z
    .number()
    .int()
    .min(1, "limit must be at least 1")
    .max(100, "limit cannot exceed 100")
    .optional()
    .describe("Number of users to return per page (1-100, default: 10)"),
  sortBy: z
    .enum(["topPosters", "topCommenters", "lastActivity"])
    .optional()
    .describe("Sort order (topPosters, topCommenters, lastActivity)"),
});

const listUsersOutput = z.object({
  users: z.array(
    z.object({
      email: z.string(),
      userId: z.string().optional(),
      name: z.string().optional(),
      customFields: z.record(z.any()).optional(),
      companies: z
        .array(
          z.object({
            id: z.string().min(1, "company id is required"),
            name: z.string().min(1, "company name is required"),
            monthlySpend: z.number().optional(),
          }),
        )
        .optional(),
      createdAt: z.string(),
      lastActivity: z.string().optional(),
      totalPosts: z.number().optional(),
      totalComments: z.number().optional(),
      totalUpvotes: z.number().optional(),
    }),
  ),
  limit: z.number(),
  totalResults: z.number(),
  nextCursor: z.string().nullable().optional(),
  hasMore: z.boolean().optional(),
  estimatedTokens: z.number(),
});

type ListUsersInput = z.infer<typeof listUsersInput>;
type ListUsersOutput = z.infer<typeof listUsersOutput>;

interface ListUsersNode {
  email: string;
  userId?: string;
  name?: string;
  customFields?: Record<string, unknown>;
  companies?: Array<{ id: string; name: string; monthlySpend?: number }>;
  createdAt: string;
  lastActivity?: string;
  totalPosts?: number;
  totalComments?: number;
  totalUpvotes?: number;
}

export const listUsers: ToolDescriptor<ListUsersInput, ListUsersOutput> = {
  id: "featurebase.list_users",
  name: "List Featurebase Users",
  description: "List identified users with pagination, filtering, and sorting",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: listUsersInput,
  output: listUsersOutput,
  handler: async (args, ctx) => {
    const limit = args.limit ?? 10;
    const sortBy = args.sortBy ?? "lastActivity";
    const query: Query = { limit, sortBy };
    if (args.cursor) query.cursor = args.cursor;

    const res = await fbRequest<{
      object: "list";
      data: ListUsersNode[];
      nextCursor?: string | null;
      hasMore?: boolean;
    }>(ctx.secrets.FEATUREBASE_API_KEY, "get", "v2/contacts", { query });
    if (!res.ok) throw new Error(`FeatureBase API error: ${res.message}`);

    return {
      users: res.data.data.map((user) => ({
        email: user.email,
        userId: user.userId,
        name: user.name,
        customFields: user.customFields,
        companies: user.companies,
        createdAt: user.createdAt,
        lastActivity: user.lastActivity,
        totalPosts: user.totalPosts,
        totalComments: user.totalComments,
        totalUpvotes: user.totalUpvotes,
      })),
      limit,
      totalResults: res.data.data.length,
      nextCursor: res.data.nextCursor !== undefined ? res.data.nextCursor : null,
      hasMore: res.data.hasMore,
      estimatedTokens: estimateTokens(res.data),
    };
  },
};

const deleteUserInput = z
  .object({
    email: z.string().email().optional().describe("User email to delete"),
    userId: safeOptional("Your system user ID to delete"),
  })
  .refine((data) => data.email || data.userId, {
    message: "Either email or userId is required",
  });

const deleteUserOutput = z.object({
  success: z.boolean(),
  email: z.string().optional(),
  userId: z.string().optional(),
  estimatedTokens: z.number(),
});

type DeleteUserInput = z.infer<typeof deleteUserInput>;
type DeleteUserOutput = z.infer<typeof deleteUserOutput>;

export const deleteUser: ToolDescriptor<DeleteUserInput, DeleteUserOutput> = {
  id: "featurebase.delete_user",
  name: "Delete Featurebase User",
  description: "Delete a user by email or userId",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: deleteUserInput,
  output: deleteUserOutput,
  handler: async (args, ctx) => {
    const queryParams: Record<string, string> = {};
    if (args.email) queryParams.email = args.email;
    if (args.userId) queryParams.userId = args.userId;
    const queryString = new URLSearchParams(queryParams).toString();

    const res = await fbRequest<{ success?: boolean; email?: string; userId?: string }>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "delete",
      `v2/organization/deleteUser?${queryString}`,
    );
    if (!res.ok) throw new Error(`Failed to delete user: ${res.message}`);
    const resultData = { success: true, email: args.email, userId: args.userId };
    return { ...resultData, estimatedTokens: estimateTokens(resultData) };
  },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  COMPANIES                                                                 ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const listCompaniesInput = z.object({
  limit: z
    .number()
    .int()
    .min(1, "limit must be at least 1")
    .max(100, "limit cannot exceed 100")
    .optional()
    .describe("Number of companies to return (1-100)"),
  cursor: safeOptional("Pagination cursor from previous response"),
});

const listCompaniesOutput = z.object({
  companies: z.array(
    z.object({
      id: z.string(),
      companyId: z.string().nullable().optional(),
      name: z.string(),
      linkedUsers: z.number(),
      lastActivity: z.string().nullable().optional(),
      plan: z.string().nullable().optional(),
      website: z.string().nullable().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
  totalCount: z.number(),
  estimatedTokens: z.number(),
});

type ListCompaniesInput = z.infer<typeof listCompaniesInput>;
type ListCompaniesOutput = z.infer<typeof listCompaniesOutput>;

interface CompanyNode {
  object?: string;
  id: string;
  companyId?: string | null;
  name: string;
  monthlySpend?: number | null;
  industry?: string | null;
  website?: string | null;
  plan?: string | null;
  linkedUsers: number;
  companySize?: number | null;
  lastActivity?: string | null;
  customFields?: Record<string, unknown>;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export const listCompanies: ToolDescriptor<ListCompaniesInput, ListCompaniesOutput> = {
  id: "featurebase.list_companies",
  name: "List Featurebase Companies",
  description: "List companies with pagination",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: listCompaniesInput,
  output: listCompaniesOutput,
  handler: async (args, ctx) => {
    const query: Query = { limit: args.limit ?? 20 };
    if (args.cursor) query.cursor = args.cursor;

    const res = await fbRequest<{
      object?: string;
      data?: CompanyNode[];
      nextCursor?: string | null;
    }>(ctx.secrets.FEATUREBASE_API_KEY, "get", "v2/companies", { query });
    if (!res.ok) throw new Error(`FeatureBase API error: ${res.message}`);

    const companiesArray = res.data.data || [];
    return {
      companies: companiesArray.map((company) => ({
        id: company.id,
        companyId: company.companyId ?? null,
        name: company.name,
        linkedUsers: company.linkedUsers,
        lastActivity: company.lastActivity ?? null,
        plan: company.plan ?? null,
        website: company.website ?? null,
      })),
      nextCursor: res.data.nextCursor ?? null,
      totalCount: companiesArray.length,
      estimatedTokens: estimateTokens(res.data),
    };
  },
};

const createCompanyInput = z.object({
  name: z
    .string()
    .min(1, "name is required")
    .refine(validateNoControlChars, "Control characters not allowed")
    .refine(validateNoPathTraversal, "Path traversal not allowed")
    .refine(validateNoCommandInjection, "Invalid characters detected")
    .describe("Company name"),
  companyId: safeId("Unique external company identifier"),
  website: safeOptional("Company website URL"),
  plan: safeOptional("Company plan/tier"),
  industry: safeOptional("Company industry"),
  monthlySpend: z.number().optional().describe("Monthly spend amount"),
  companySize: z.number().int().optional().describe("Number of employees"),
});

const createCompanyOutput = z.object({
  company: z.object({
    id: z.string(),
    companyId: z.string().nullable().optional(),
    name: z.string(),
    linkedUsers: z.number(),
    lastActivity: z.string().nullable().optional(),
    plan: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
  }),
  estimatedTokens: z.number(),
});

type CreateCompanyInput = z.infer<typeof createCompanyInput>;
type CreateCompanyOutput = z.infer<typeof createCompanyOutput>;

export const createCompany: ToolDescriptor<CreateCompanyInput, CreateCompanyOutput> = {
  id: "featurebase.create_company",
  name: "Create Featurebase Company",
  description: "Create a new company",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: createCompanyInput,
  output: createCompanyOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<CompanyNode>(ctx.secrets.FEATUREBASE_API_KEY, "post", "v2/companies", {
      json: {
        name: args.name,
        companyId: args.companyId,
        ...(args.website !== undefined && { website: args.website }),
        ...(args.plan !== undefined && { plan: args.plan }),
        ...(args.industry !== undefined && { industry: args.industry }),
        ...(args.monthlySpend !== undefined && { monthlySpend: args.monthlySpend }),
        ...(args.companySize !== undefined && { companySize: args.companySize }),
      },
    });
    if (!res.ok) throw new Error(`Failed to create company: ${res.message}`);
    const company = res.data;
    const companyData = {
      id: company.id,
      companyId: company.companyId ?? null,
      name: company.name,
      linkedUsers: company.linkedUsers ?? 0,
      lastActivity: company.lastActivity ?? null,
      plan: company.plan ?? null,
      website: company.website ?? null,
    };
    return { company: companyData, estimatedTokens: estimateTokens(companyData) };
  },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  WEBHOOKS                                                                  ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const listWebhooksInput = z.object({
  limit: z
    .number()
    .int()
    .min(1, "limit must be at least 1")
    .max(100, "limit cannot exceed 100")
    .optional()
    .describe("Number of webhooks to return (1-100)"),
  cursor: safeOptional("Pagination cursor from previous response"),
});

const listWebhooksOutput = z.object({
  webhooks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      url: z.string(),
      topics: z.array(z.string()),
      status: z.string(),
      description: z.string().nullable().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
  totalCount: z.number(),
  estimatedTokens: z.number(),
});

type ListWebhooksInput = z.infer<typeof listWebhooksInput>;
type ListWebhooksOutput = z.infer<typeof listWebhooksOutput>;

interface WebhookNode {
  object?: string;
  id: string;
  name: string;
  url: string;
  secret?: string;
  description?: string | null;
  topics: string[];
  status: string;
  requestConfig?: { timeoutMs: number; headers: Record<string, string> };
}

export const listWebhooks: ToolDescriptor<ListWebhooksInput, ListWebhooksOutput> = {
  id: "featurebase.list_webhooks",
  name: "List Featurebase Webhooks",
  description: "List webhooks with pagination (secret is excluded from output)",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: listWebhooksInput,
  output: listWebhooksOutput,
  handler: async (args, ctx) => {
    const query: Query = { limit: args.limit ?? 20 };
    if (args.cursor) query.cursor = args.cursor;

    const res = await fbRequest<{
      object?: string;
      data?: WebhookNode[];
      nextCursor?: string | null;
    }>(ctx.secrets.FEATUREBASE_API_KEY, "get", "v2/webhooks", { query });
    if (!res.ok) throw new Error(`FeatureBase API error: ${res.message}`);

    const webhooksArray = res.data.data || [];
    // Intentionally omit secret from output
    return {
      webhooks: webhooksArray.map((webhook) => ({
        id: webhook.id,
        name: webhook.name,
        url: webhook.url,
        topics: webhook.topics,
        status: webhook.status,
        description: webhook.description ?? null,
      })),
      nextCursor: res.data.nextCursor ?? null,
      totalCount: webhooksArray.length,
      estimatedTokens: estimateTokens(res.data),
    };
  },
};

const createWebhookInput = z.object({
  name: z
    .string()
    .min(1, "name is required")
    .refine(validateNoControlChars, "Control characters not allowed")
    .refine(validateNoPathTraversal, "Path traversal not allowed")
    .refine(validateNoCommandInjection, "Invalid characters detected")
    .describe("Webhook name"),
  url: z
    .string()
    .min(1, "url is required")
    .url("url must be a valid URL")
    .refine(validateNoControlChars, "Control characters not allowed")
    .refine(validateNoPathTraversal, "Path traversal not allowed")
    .refine(validateNoCommandInjection, "Invalid characters detected")
    .describe("Webhook destination URL"),
  topics: z
    .array(z.string())
    .min(1, "topics must have at least one entry")
    .describe(
      'Event topics to subscribe to (e.g. ["post.created", "post.voted", "post.updated", "post.deleted", "comment.created", "changelog.published"])',
    ),
  description: safeOptional("Optional webhook description"),
});

const createWebhookOutput = z.object({
  webhook: z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    topics: z.array(z.string()),
    status: z.string(),
    description: z.string().nullable().optional(),
  }),
  estimatedTokens: z.number(),
});

type CreateWebhookInput = z.infer<typeof createWebhookInput>;
type CreateWebhookOutput = z.infer<typeof createWebhookOutput>;

export const createWebhook: ToolDescriptor<CreateWebhookInput, CreateWebhookOutput> = {
  id: "featurebase.create_webhook",
  name: "Create Featurebase Webhook",
  description: "Create a new webhook subscription",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: createWebhookInput,
  output: createWebhookOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<WebhookNode>(ctx.secrets.FEATUREBASE_API_KEY, "post", "v2/webhooks", {
      json: {
        name: args.name,
        url: args.url,
        topics: args.topics,
        ...(args.description !== undefined && { description: args.description }),
      },
    });
    if (!res.ok) throw new Error(`Failed to create webhook: ${res.message}`);
    const webhook = res.data;
    // Intentionally omit secret from output
    const webhookData = {
      id: webhook.id,
      name: webhook.name,
      url: webhook.url,
      topics: webhook.topics,
      status: webhook.status,
      description: webhook.description ?? null,
    };
    return { webhook: webhookData, estimatedTokens: estimateTokens(webhookData) };
  },
};

const deleteWebhookInput = z.object({ webhookId: safeId("Webhook ID to delete") });
const deleteWebhookOutput = z.object({
  success: z.boolean(),
  webhookId: z.string(),
  estimatedTokens: z.number(),
});

type DeleteWebhookInput = z.infer<typeof deleteWebhookInput>;
type DeleteWebhookOutput = z.infer<typeof deleteWebhookOutput>;

export const deleteWebhook: ToolDescriptor<DeleteWebhookInput, DeleteWebhookOutput> = {
  id: "featurebase.delete_webhook",
  name: "Delete Featurebase Webhook",
  description: "Delete a webhook",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: deleteWebhookInput,
  output: deleteWebhookOutput,
  handler: async (args, ctx) => {
    const res = await fbRequest<{ success?: boolean }>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "delete",
      "v2/webhooks/" + encodeURIComponent(args.webhookId),
    );
    if (!res.ok) throw new Error(`Failed to delete webhook: ${res.message}`);
    const resultData = { success: true, webhookId: args.webhookId };
    return { ...resultData, estimatedTokens: estimateTokens(resultData) };
  },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  CUSTOM FIELDS                                                             ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const fieldTypeEnum = z.enum(["string", "number", "boolean", "date", "array"]);

const listCustomFieldsInput = z.object({});

const listCustomFieldsOutput = z.object({
  fields: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: fieldTypeEnum,
      options: z.array(z.string()).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      itemType: z.string().optional(),
      required: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  estimatedTokens: z.number(),
});

type ListCustomFieldsInput = z.infer<typeof listCustomFieldsInput>;
type ListCustomFieldsOutput = z.infer<typeof listCustomFieldsOutput>;

interface CustomFieldNode {
  id: string;
  name: string;
  type: "string" | "number" | "boolean" | "date" | "array";
  options?: string[];
  min?: number;
  max?: number;
  itemType?: string;
  required: boolean;
  createdAt: string;
  updatedAt: string;
}

export const listCustomFields: ToolDescriptor<ListCustomFieldsInput, ListCustomFieldsOutput> = {
  id: "featurebase.list_custom_fields",
  name: "List Featurebase Custom Fields",
  description: "List all custom field definitions",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: listCustomFieldsInput,
  output: listCustomFieldsOutput,
  handler: async (_args, ctx) => {
    const res = await fbRequest<{ fields?: CustomFieldNode[] }>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "get",
      "v2/custom_fields",
    );
    if (!res.ok) throw new Error(`FeatureBase API error: ${res.message}`);
    return {
      fields: res.data.fields || [],
      estimatedTokens: estimateTokens(res.data),
    };
  },
};

const createCustomFieldInput = z
  .object({
    name: z
      .string()
      .min(1, "name is required")
      .refine(validateNoControlChars, "Control characters not allowed")
      .refine(validateNoPathTraversal, "Path traversal not allowed")
      .refine(validateNoCommandInjection, "Invalid characters detected")
      .describe("Field name (snake_case recommended)"),
    type: fieldTypeEnum.describe("Field type: string, number, boolean, date, array"),
    options: z
      .array(z.string())
      .min(1, "options array must have at least one value")
      .optional()
      .describe("Valid values for string enum fields"),
    min: z.number().optional().describe("Minimum value for number fields"),
    max: z.number().optional().describe("Maximum value for number fields"),
    itemType: z.string().optional().describe("Type of array items (string or number)"),
    required: z.boolean().optional().describe("Whether field is required (default: false)"),
  })
  .refine(
    (data) => {
      if (data.type === "number" && data.min !== undefined && data.max !== undefined) {
        return data.min <= data.max;
      }
      return true;
    },
    { message: "min must be less than or equal to max" },
  )
  .refine(
    (data) => {
      if (data.type === "array") {
        return data.itemType !== undefined;
      }
      return true;
    },
    { message: "itemType is required for array fields" },
  );

const createCustomFieldOutput = z.object({
  field: z.object({
    id: z.string(),
    name: z.string(),
    type: fieldTypeEnum,
    options: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    itemType: z.string().optional(),
    required: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  estimatedTokens: z.number(),
});

type CreateCustomFieldInput = z.infer<typeof createCustomFieldInput>;
type CreateCustomFieldOutput = z.infer<typeof createCustomFieldOutput>;

export const createCustomField: ToolDescriptor<CreateCustomFieldInput, CreateCustomFieldOutput> = {
  id: "featurebase.create_custom_field",
  name: "Create Featurebase Custom Field",
  description: "Create a new custom field definition",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: createCustomFieldInput,
  output: createCustomFieldOutput,
  handler: async (args, ctx) => {
    const requestBody: Record<string, unknown> = {
      name: args.name,
      type: args.type,
    };
    if (args.options !== undefined) requestBody.options = args.options;
    if (args.min !== undefined) requestBody.min = args.min;
    if (args.max !== undefined) requestBody.max = args.max;
    if (args.itemType !== undefined) requestBody.itemType = args.itemType;
    if (args.required !== undefined) requestBody.required = args.required;

    const res = await fbRequest<{ field: CustomFieldNode }>(
      ctx.secrets.FEATUREBASE_API_KEY,
      "post",
      "v2/custom_fields",
      { json: requestBody },
    );
    if (!res.ok) throw new Error(`Failed to create custom field: ${res.message}`);
    return {
      field: res.data.field,
      estimatedTokens: estimateTokens(res.data.field),
    };
  },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  BOARDS                                                                    ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const listBoardsInput = z.object({});

const listBoardsOutput = z.object({
  boards: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      icon: z
        .object({
          type: z.string(),
          value: z.string(),
        })
        .nullable()
        .optional(),
    }),
  ),
  totalCount: z.number(),
  estimatedTokens: z.number(),
});

type ListBoardsInput = z.infer<typeof listBoardsInput>;
type ListBoardsOutput = z.infer<typeof listBoardsOutput>;

interface BoardNode {
  object?: string;
  id: string;
  name: string;
  icon?: { type: string; value: string } | null;
  access?: { adminOnly: boolean };
  features?: Record<string, boolean>;
  postDefaults?: Record<string, string>;
}

export const listBoards: ToolDescriptor<ListBoardsInput, ListBoardsOutput> = {
  id: "featurebase.list_boards",
  name: "List Featurebase Boards",
  description: "List all feedback boards",
  auth: ["FEATUREBASE_API_KEY"],
  wraps: { type: "rest" },
  input: listBoardsInput,
  output: listBoardsOutput,
  handler: async (_args, ctx) => {
    // Response is a flat array, not a paginated list.
    const res = await fbRequest<BoardNode[]>(ctx.secrets.FEATUREBASE_API_KEY, "get", "v2/boards");
    if (!res.ok) throw new Error(`FeatureBase API error: ${res.message}`);

    const boardsArray = Array.isArray(res.data) ? res.data : [];
    return {
      boards: boardsArray.map((board) => ({
        id: board.id,
        name: board.name,
        icon: board.icon ?? null,
      })),
      totalCount: boardsArray.length,
      estimatedTokens: estimateTokens(boardsArray),
    };
  },
};
