/**
 * WS-A featurebase port — behavioral tests for the ported Featurebase ToolDescriptors.
 *
 * Proves the §6.2 adapter invariants for the featurebase service:
 *  - Descriptor shape: id, name, auth, input (ZodType), output (ZodType), handler
 *  - CTX-only auth: secret read from ctx.secrets.FEATUREBASE_API_KEY only;
 *    header is X-API-Key (NOT Authorization/Bearer).
 *    NOTE: "never reads env" is structurally guaranteed — the wrapper imports only
 *    `zod` and reads `ctx.secrets`; no `process.env` reference exists anywhere.
 *  - Input validation rejects unsafe values (command injection, out-of-range limits).
 *  - Output mapping faithfully truncates, applies fallbacks, and sets estimatedTokens.
 *  - Form-encoding branch (createComment): Content-Type application/x-www-form-urlencoded.
 *  - PATCH branch (updateCollection via fbPatch): method PATCH, Content-Type application/json.
 *  - 404 special-casing: getPost 404 → throws "Post not found: <id>".
 *  - Error sanitization: sk_... tokens are redacted to [API_KEY_REDACTED].
 *  - Delete shape: deletePost returns { success: true, postId, estimatedTokens }.
 *
 * Transport is injected via `__setFetch` — no real HTTP. Every handler test resets
 * the transport in afterEach via `__resetFetch`.
 *
 * The per-tool schema/compile/load tests are already covered by bundled-catalog.test.ts
 * (imports every wrapper.js and recomputes schemaHash). This suite tests behavior only.
 */
import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import {
  listPosts,
  getPost,
  createComment,
  updateCollection,
  deletePost,
  __setFetch,
  __resetFetch,
  type FetchLike,
} from "../../.agentsmesh/tools/featurebase/wrapper.js";

/** Build a fake fetch that records the request and returns a canned JSON body. */
function fakeFetch(
  body: unknown,
  captured: { url?: string; init?: RequestInit } = {},
  status = 200,
): FetchLike {
  return async (url, init) => {
    captured.url = url;
    captured.init = init;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

afterEach(() => __resetFetch());

// ── Test 1: Descriptor shape ────────────────────────────────────────────────

describe("featurebase.list_posts descriptor shape (adapter rules)", () => {
  it("is a ToolDescriptor with id/name/auth/input/output/handler", () => {
    expect(listPosts.id).toBe("featurebase.list_posts");
    expect(typeof listPosts.name).toBe("string");
    expect(listPosts.auth).toEqual(["FEATUREBASE_API_KEY"]);
    expect(listPosts.input).toBeInstanceOf(z.ZodType);
    expect(listPosts.output).toBeInstanceOf(z.ZodType);
    expect(typeof listPosts.handler).toBe("function");
  });
});

// ── Test 2: CTX-only auth — X-API-Key header + correct URL/verb ────────────

describe("featurebase handler is CTX-only (X-API-Key, injected transport)", () => {
  it("sends the secret in the X-API-Key header (not Authorization) to the do.featurebase.app GET URL", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(fakeFetch({ id: "p1", title: "T" }, captured));

    await getPost.handler(
      { postId: "p1" },
      { secrets: { FEATUREBASE_API_KEY: "fb_test123" } },
    );

    expect(captured.url).toBe("https://do.featurebase.app/v2/posts/p1");
    expect(captured.init?.method).toBe("GET");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("fb_test123");
    expect(headers["Authorization"]).toBeUndefined();
  });
});

// ── Tests 3–4: Input validation ─────────────────────────────────────────────

describe("featurebase input validation", () => {
  it("rejects a command-injection sequence in an id field", () => {
    // postId uses safeId() whose validateNoCommandInjection rejects ';'
    expect(getPost.input.safeParse({ postId: "p1; rm -rf /" }).success).toBe(false);
  });

  it("rejects a limit above the allowed maximum", () => {
    // limit is z.number().int().min(1).max(100)
    expect(listPosts.input.safeParse({ limit: 9999 }).success).toBe(false);
  });
});

// ── Tests 5–6: Output mapping ───────────────────────────────────────────────

describe("featurebase output mapping (list + get representatives)", () => {
  it("maps list_posts results, truncates content to 500 chars, falls back status to 'unknown', and sets estimatedTokens", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const POSTS_OK = {
      results: [
        {
          id: "p1",
          slug: "s1",
          title: "First",
          content: "a".repeat(800), // > 500 to prove truncation
          // NOTE: no postStatus → exercises the `|| "unknown"` fallback
          date: "2026-01-01T00:00:00.000Z",
          lastModified: "2026-01-02T00:00:00.000Z",
          upvotes: 3,
          postTags: ["x"],
        },
      ],
      page: 1,
      totalPages: 1,
      totalResults: 1,
    };
    __setFetch(fakeFetch(POSTS_OK, captured));

    const out = listPosts.output.parse(
      await listPosts.handler({}, { secrets: { FEATUREBASE_API_KEY: "k" } }),
    );

    expect(out.posts[0].content.length).toBe(500);
    expect(out.posts[0].status).toBe("unknown");
    expect(out.totalResults).toBe(1);
    expect(typeof out.estimatedTokens).toBe("number");
    expect(out.estimatedTokens).toBeGreaterThan(0);
    // Confirm the in-handler defaults were applied (no .default() on input schema)
    expect(captured.url).toContain("limit=10");
    expect(captured.url).toContain("sortBy=createdAt");
  });

  it("maps get_post and falls back content from body when content is absent", async () => {
    __setFetch(fakeFetch({ id: "p1", title: "T", body: "from-body", status: "open" }));

    const out = getPost.output.parse(
      await getPost.handler({ postId: "p1" }, { secrets: { FEATUREBASE_API_KEY: "k" } }),
    );

    // content || body || "" fallback (wrapper.ts line 360)
    expect(out.post.content).toBe("from-body");
    // postStatus?.name || status fallback (wrapper.ts line 361)
    expect(out.post.status).toBe("open");
    expect(typeof out.estimatedTokens).toBe("number");
  });
});

// ── Test 7: Form-encoding branch ────────────────────────────────────────────

describe("featurebase form-encoded branch (comments create)", () => {
  it("sends Content-Type application/x-www-form-urlencoded with the right body keys", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const COMMENT_OK = {
      id: "c1",
      submissionId: "post1",
      content: "hello world",
      isPrivate: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      author: { id: "u1", name: "Alice", email: "alice@example.com" },
      upvotes: 0,
      downvotes: 0,
      score: 0,
    };
    __setFetch(fakeFetch(COMMENT_OK, captured));

    await createComment.handler(
      { submissionId: "post1", content: "hello world", isPrivate: true },
      { secrets: { FEATUREBASE_API_KEY: "fb_k" } },
    );

    expect(captured.url).toBe("https://do.featurebase.app/v2/comment");
    expect(captured.init?.method).toBe("POST");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(captured.init?.body as string);
    expect(body.get("content")).toBe("hello world");
    expect(body.get("submissionId")).toBe("post1");
    expect(body.get("isPrivate")).toBe("true");
    expect(body.get("changelogId")).toBeNull(); // not sent when absent
    expect(headers["X-API-Key"]).toBe("fb_k"); // auth still applies on the form path
  });
});

// ── Test 8: PATCH branch ─────────────────────────────────────────────────────

describe("featurebase PATCH branch (fbPatch)", () => {
  it("issues method PATCH with application/json for a collection update", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const COLLECTION_OK = {
      id: "col1",
      name: "Renamed",
      description: null,
      slug: "renamed",
      parentId: null,
      helpCenterId: "hc1",
      articleCount: 5,
      order: null,
      path: "/renamed",
    };
    __setFetch(fakeFetch(COLLECTION_OK, captured));

    await updateCollection.handler(
      { collectionId: "col1", name: "Renamed" },
      { secrets: { FEATUREBASE_API_KEY: "fb_k" } },
    );

    expect(captured.init?.method).toBe("PATCH");
    expect(captured.url).toBe(
      "https://do.featurebase.app/v2/help_center/collections/col1",
    );
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(captured.init?.body as string).name).toBe("Renamed");
  });
});

// ── Tests 9–10: 404 special-casing + error sanitization ─────────────────────

describe("featurebase 404 special-casing", () => {
  it('maps a 404 to a "not found" message for get_post', async () => {
    __setFetch(fakeFetch({ error: "nope" }, {}, 404));

    await expect(
      getPost.handler({ postId: "missing" }, { secrets: { FEATUREBASE_API_KEY: "k" } }),
    ).rejects.toThrow(/not found/i);
  });

  it("redacts an sk_ token from an upstream error body", async () => {
    // fakeFetch JSON.stringifies the body; the raw string still contains the token
    // so sanitizeErrorMessage must replace it before it surfaces in the Error message.
    __setFetch(fakeFetch("auth failed for sk_live_ABCDEF123456", {}, 500));

    await expect(
      getPost.handler({ postId: "p1" }, { secrets: { FEATUREBASE_API_KEY: "k" } }),
    ).rejects.toThrow(/\[API_KEY_REDACTED\]/);

    // Also verify the raw token is NOT present in the thrown error
    __setFetch(fakeFetch("auth failed for sk_live_ABCDEF123456", {}, 500));
    const err = await getPost
      .handler({ postId: "p1" }, { secrets: { FEATUREBASE_API_KEY: "k" } })
      .catch((e) => e as Error);
    expect(err.message).not.toContain("sk_live_ABCDEF123456");
    expect(err.message).toContain("[API_KEY_REDACTED]");
  });
});

// ── Test 11: Delete returns { success: true, ... } ──────────────────────────

describe("featurebase delete returns success", () => {
  it("returns success true with the deleted id and estimatedTokens", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(fakeFetch({ success: true }, captured));

    const out = deletePost.output.parse(
      await deletePost.handler(
        { postId: "p1" },
        { secrets: { FEATUREBASE_API_KEY: "k" } },
      ),
    );

    expect(out.success).toBe(true);
    expect(out.postId).toBe("p1");
    expect(typeof out.estimatedTokens).toBe("number");
    expect(captured.init?.method).toBe("DELETE");
    expect(captured.url).toContain("v2/posts/p1");
  });
});
