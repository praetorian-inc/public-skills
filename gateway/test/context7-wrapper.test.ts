/**
 * WS-A bulk port — TDD for the ported Context7 ToolDescriptors
 * (`context7.resolve-library-id`, `context7.get-library-docs`).
 *
 * Context7 is KEYLESS (auth: []): the public API works without a key (low rate
 * limits) and accepts an optional `CONTEXT7_API_KEY` for higher limits. The
 * handlers therefore make the request with NO Authorization header by default,
 * adding one only if `ctx.secrets.CONTEXT7_API_KEY` is supplied (still CTX-only —
 * never an env read).
 *
 * Proves the §6.2 adapter rules:
 *  - input validation rejects bad args (so the runner maps to `invalid_args`),
 *  - output validation shape is honoured,
 *  - the handler is CTX-only with an INJECTED fetch (no real network).
 *
 * Endpoints (verified against the Context7 public API guide):
 *   GET https://context7.com/api/v2/libs/search?libraryName=&query=
 *   GET https://context7.com/api/v2/context?libraryId=&query=&type=
 */
import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import {
  resolveLibraryId,
  getLibraryDocs,
  __setFetch,
  __resetFetch,
  type FetchLike,
} from "../../.agentsmesh/tools/context7/wrapper.js";

function fakeFetch(
  body: unknown,
  captured: { url?: string; init?: RequestInit } = {},
  status = 200,
  asText = false,
): FetchLike {
  return async (url, init) => {
    captured.url = url;
    captured.init = init;
    const payload = asText ? (body as string) : JSON.stringify(body);
    return new Response(payload, {
      status,
      headers: { "content-type": asText ? "text/plain" : "application/json" },
    });
  };
}

const SEARCH_OK = {
  results: [
    {
      id: "/facebook/react",
      title: "React",
      description: "A JS library for building UIs",
      totalSnippets: 1200,
      trustScore: 9,
      benchmarkScore: 88,
    },
    { id: "/vuejs/core", title: "Vue", description: "The progressive framework" },
  ],
};

const DOCS_TEXT = "# React\n\nuseState is a Hook that lets you add state.";

afterEach(() => __resetFetch());

describe("context7.resolve-library-id descriptor shape (adapter rules)", () => {
  it("is a ToolDescriptor with id/name/input/output and KEYLESS auth ([])", () => {
    expect(resolveLibraryId.id).toBe("context7.resolve-library-id");
    expect(typeof resolveLibraryId.name).toBe("string");
    expect(resolveLibraryId.auth).toEqual([]);
    expect(resolveLibraryId.input).toBeInstanceOf(z.ZodType);
    expect(resolveLibraryId.output).toBeInstanceOf(z.ZodType);
    expect(typeof resolveLibraryId.handler).toBe("function");
  });
});

describe("context7.resolve-library-id input validation", () => {
  it("rejects an empty libraryName", () => {
    expect(resolveLibraryId.input.safeParse({ libraryName: "" }).success).toBe(false);
  });

  it("rejects a path-traversal sequence in libraryName", () => {
    expect(resolveLibraryId.input.safeParse({ libraryName: "../etc/passwd" }).success).toBe(false);
  });

  it("accepts a clean libraryName (query optional; default applied in handler)", () => {
    const parsed = resolveLibraryId.input.parse({ libraryName: "react" });
    expect(parsed).toMatchObject({ libraryName: "react" });
    expect(parsed.query).toBeUndefined();
  });
});

describe("context7.resolve-library-id handler (CTX-only, keyless)", () => {
  it("calls /libs/search with NO Authorization header when no key is supplied", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(fakeFetch(SEARCH_OK, captured));

    await resolveLibraryId.handler({ libraryName: "react" }, { secrets: {} });

    expect(captured.url).toContain("https://context7.com/api/v2/libs/search");
    expect(captured.url).toContain("libraryName=react");
    const headers = (captured.init?.headers as Record<string, string>) ?? {};
    expect(headers.Authorization).toBeUndefined();
  });

  it("adds a Bearer header when CONTEXT7_API_KEY is supplied", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(fakeFetch(SEARCH_OK, captured));

    await resolveLibraryId.handler(
      { libraryName: "react" },
      { secrets: { CONTEXT7_API_KEY: "ctx7sk-abc" } },
    );

    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ctx7sk-abc");
  });

  it("maps results into the libraries array with totalResults", async () => {
    __setFetch(fakeFetch(SEARCH_OK));
    const out = await resolveLibraryId.handler({ libraryName: "react" }, { secrets: {} });
    const parsed = resolveLibraryId.output.parse(out);
    expect(parsed.totalResults).toBe(2);
    expect(parsed.libraries[0]).toMatchObject({
      id: "/facebook/react",
      name: "React",
      codeSnippets: 1200,
    });
  });

  it("throws on a non-2xx status", async () => {
    __setFetch(fakeFetch({ error: "boom" }, {}, 500));
    await expect(
      resolveLibraryId.handler({ libraryName: "react" }, { secrets: {} }),
    ).rejects.toThrow(/500/);
  });
});

describe("context7.get-library-docs descriptor shape (adapter rules)", () => {
  it("is a ToolDescriptor with id/name/input/output and KEYLESS auth ([])", () => {
    expect(getLibraryDocs.id).toBe("context7.get-library-docs");
    expect(getLibraryDocs.auth).toEqual([]);
    expect(getLibraryDocs.input).toBeInstanceOf(z.ZodType);
    expect(getLibraryDocs.output).toBeInstanceOf(z.ZodType);
    expect(typeof getLibraryDocs.handler).toBe("function");
  });
});

describe("context7.get-library-docs input validation", () => {
  it("rejects an empty libraryId", () => {
    expect(getLibraryDocs.input.safeParse({ context7CompatibleLibraryID: "" }).success).toBe(false);
  });

  it("rejects an invalid mode", () => {
    expect(
      getLibraryDocs.input.safeParse({
        context7CompatibleLibraryID: "/facebook/react",
        mode: "bogus",
      }).success,
    ).toBe(false);
  });

  it("accepts a clean libraryId (mode/page optional; defaults applied in handler)", () => {
    const parsed = getLibraryDocs.input.parse({ context7CompatibleLibraryID: "/facebook/react" });
    expect(parsed).toMatchObject({ context7CompatibleLibraryID: "/facebook/react" });
    expect(parsed.mode).toBeUndefined();
    expect(parsed.page).toBeUndefined();
  });
});

describe("context7.get-library-docs handler (CTX-only, keyless)", () => {
  it("calls /context with the library id and returns derived metadata", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(fakeFetch(DOCS_TEXT, captured, 200, true));

    const out = await getLibraryDocs.handler(
      { context7CompatibleLibraryID: "/facebook/react", topic: "hooks" },
      { secrets: {} },
    );

    expect(captured.url).toContain("https://context7.com/api/v2/context");
    expect(captured.url).toContain("libraryId=%2Ffacebook%2Freact");
    const parsed = getLibraryDocs.output.parse(out);
    expect(parsed.libraryId).toBe("/facebook/react");
    expect(parsed.libraryName).toBe("react");
    expect(parsed.content).toContain("useState");
    expect(parsed.mode).toBe("code");
    expect(parsed.page).toBe(1);
    expect(typeof parsed.estimatedTokens).toBe("number");
    expect(parsed.topic).toBe("hooks");
  });

  it("handles a scoped package name (@types/node)", async () => {
    __setFetch(fakeFetch(DOCS_TEXT, {}, 200, true));
    const out = await getLibraryDocs.handler(
      { context7CompatibleLibraryID: "/DefinitelyTyped/@types/node" },
      { secrets: {} },
    );
    const parsed = getLibraryDocs.output.parse(out);
    expect(parsed.libraryName).toBe("@types/node");
  });

  it("throws on a non-2xx status", async () => {
    __setFetch(fakeFetch("err", {}, 404, true));
    await expect(
      getLibraryDocs.handler({ context7CompatibleLibraryID: "/x/y" }, { secrets: {} }),
    ).rejects.toThrow(/404/);
  });
});
