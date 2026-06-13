/**
 * WS-A bulk port — TDD for the ported Perplexity ToolDescriptors
 * (`perplexity.search`, `perplexity.ask`).
 *
 * Proves the §6.2 adapter rules for the two highest-value Perplexity tools:
 *  - input validation rejects bad args (so the runner maps to `invalid_args`),
 *  - output validation shape is honoured,
 *  - the handler is CTX-only: it builds the Perplexity request from
 *    `ctx.secrets.PERPLEXITY_API_KEY` and an INJECTED fetch (never a real
 *    network call, never an env read), sending the key as a Bearer token.
 *
 * The catalog wrapper lives at ../../.agentsmesh/tools/perplexity/wrapper.ts; the
 * transport is injected via `__setFetch` so no real HTTP happens in tests.
 */
import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import {
  perplexitySearch,
  perplexityAsk,
  __setFetch,
  __resetFetch,
  type FetchLike,
} from "../../.agentsmesh/tools/perplexity/wrapper.js";

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

const SEARCH_OK = {
  results: [
    { title: "TS Handbook", url: "https://ts.dev/a", snippet: "Type-safe JS." },
    { title: "TS Deep Dive", url: "https://ts.dev/b", snippet: "Advanced types." },
  ],
};

const CHAT_OK = {
  choices: [{ message: { content: "**TypeScript** is a typed superset of JavaScript." } }],
  citations: ["https://ts.dev/x", "https://ts.dev/y"],
};

afterEach(() => __resetFetch());

describe("perplexity.search descriptor shape (adapter rules)", () => {
  it("is a ToolDescriptor with id/name/input/output/auth/handler", () => {
    expect(perplexitySearch.id).toBe("perplexity.search");
    expect(typeof perplexitySearch.name).toBe("string");
    expect(perplexitySearch.auth).toEqual(["PERPLEXITY_API_KEY"]);
    expect(perplexitySearch.input).toBeInstanceOf(z.ZodType);
    expect(perplexitySearch.output).toBeInstanceOf(z.ZodType);
    expect(typeof perplexitySearch.handler).toBe("function");
  });
});

describe("perplexity.search input validation", () => {
  it("rejects an empty query", () => {
    expect(perplexitySearch.input.safeParse({ query: "" }).success).toBe(false);
  });

  it("rejects a command-injection sequence in the query", () => {
    expect(perplexitySearch.input.safeParse({ query: "foo; rm -rf /" }).success).toBe(false);
  });

  it("rejects max_results above the allowed maximum", () => {
    expect(perplexitySearch.input.safeParse({ query: "ok", max_results: 99 }).success).toBe(false);
  });

  it("rejects a malformed country code", () => {
    expect(perplexitySearch.input.safeParse({ query: "ok", country: "usa" }).success).toBe(false);
  });

  it("accepts a clean query (max_results optional; default applied in handler)", () => {
    const parsed = perplexitySearch.input.parse({ query: "typescript" });
    expect(parsed).toMatchObject({ query: "typescript" });
    expect(parsed.max_results).toBeUndefined();
  });
});

describe("perplexity.search handler (CTX-only, injected transport)", () => {
  it("sends the secret as a Bearer token to the /search endpoint", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(fakeFetch(SEARCH_OK, captured));

    await perplexitySearch.handler(
      { query: "typescript", max_results: 5, country: "US" },
      { secrets: { PERPLEXITY_API_KEY: "pplx-test123" } },
    );

    expect(captured.url).toBe("https://api.perplexity.ai/search");
    expect(captured.init?.method).toBe("POST");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pplx-test123");
    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.query).toBe("typescript");
    expect(body.max_results).toBe(5);
    expect(body.country).toBe("US");
  });

  it("formats results into content and appends a Sources list", async () => {
    __setFetch(fakeFetch(SEARCH_OK));
    const out = await perplexitySearch.handler(
      { query: "typescript" },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexitySearch.output.parse(out);
    expect(parsed.content).toContain("TS Handbook");
    expect(parsed.content).toContain("Sources:");
    expect(parsed.content).toContain("https://ts.dev/a");
    expect(parsed.metadata?.query).toBe("typescript");
  });

  it("throws when the API returns a non-2xx status", async () => {
    __setFetch(fakeFetch({ error: "rate limited" }, {}, 429));
    await expect(
      perplexitySearch.handler({ query: "x" }, { secrets: { PERPLEXITY_API_KEY: "k" } }),
    ).rejects.toThrow(/429/);
  });

  it("throws on an empty result set (no content)", async () => {
    __setFetch(fakeFetch({ results: [] }));
    await expect(
      perplexitySearch.handler({ query: "x" }, { secrets: { PERPLEXITY_API_KEY: "k" } }),
    ).rejects.toThrow(/Empty response/);
  });
});

describe("perplexity.ask descriptor shape (adapter rules)", () => {
  it("is a ToolDescriptor with id/name/input/output/auth/handler", () => {
    expect(perplexityAsk.id).toBe("perplexity.ask");
    expect(perplexityAsk.auth).toEqual(["PERPLEXITY_API_KEY"]);
    expect(perplexityAsk.input).toBeInstanceOf(z.ZodType);
    expect(perplexityAsk.output).toBeInstanceOf(z.ZodType);
    expect(typeof perplexityAsk.handler).toBe("function");
  });
});

describe("perplexity.ask input validation", () => {
  it("rejects an input with neither messages nor query", () => {
    expect(perplexityAsk.input.safeParse({}).success).toBe(false);
  });

  it("rejects an empty messages array", () => {
    expect(perplexityAsk.input.safeParse({ messages: [] }).success).toBe(false);
  });

  it("accepts a convenience query string", () => {
    expect(perplexityAsk.input.safeParse({ query: "what is TS?" }).success).toBe(true);
  });

  it("accepts a full messages array", () => {
    const parsed = perplexityAsk.input.parse({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(parsed.messages?.length).toBe(1);
  });
});

describe("perplexity.ask handler (CTX-only, injected transport)", () => {
  it("wraps a convenience query into a messages array and uses sonar-pro", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(fakeFetch(CHAT_OK, captured));

    await perplexityAsk.handler(
      { query: "what is TypeScript?" },
      { secrets: { PERPLEXITY_API_KEY: "pplx-test123" } },
    );

    expect(captured.url).toBe("https://api.perplexity.ai/chat/completions");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pplx-test123");
    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.model).toBe("sonar-pro");
    expect(body.messages).toEqual([{ role: "user", content: "what is TypeScript?" }]);
  });

  it("returns content with appended Sources and a messageCount", async () => {
    __setFetch(fakeFetch(CHAT_OK));
    const out = await perplexityAsk.handler(
      { messages: [{ role: "user", content: "hi" }] },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexityAsk.output.parse(out);
    expect(parsed.content).toContain("TypeScript");
    expect(parsed.content).toContain("Sources:");
    expect(parsed.metadata?.messageCount).toBe(1);
  });

  it("throws on an empty model response", async () => {
    __setFetch(fakeFetch({ choices: [{ message: { content: "" } }] }));
    await expect(
      perplexityAsk.handler({ query: "x" }, { secrets: { PERPLEXITY_API_KEY: "k" } }),
    ).rejects.toThrow(/Empty response/);
  });
});
