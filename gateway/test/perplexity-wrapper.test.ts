/**
 * WS-A bulk port — TDD for the ported Perplexity ToolDescriptors
 * (`perplexity.search`, `perplexity.ask`, `perplexity.research`, `perplexity.reason`).
 *
 * Proves the §6.2 adapter rules for the Perplexity tools:
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
  perplexityResearch,
  perplexityReason,
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

// ════════════════════════════════════════════════════════════════════════════
// perplexity.research
// ════════════════════════════════════════════════════════════════════════════

const RESEARCH_OK = {
  choices: [
    {
      message: {
        content:
          "TypeScript [1] is a typed superset [2] of JavaScript maintained by Microsoft.",
      },
    },
  ],
  citations: ["https://ts.dev/docs", "https://ts.dev/handbook"],
};

describe("perplexity.research descriptor shape", () => {
  it("is a ToolDescriptor with id/name/input/output/auth/handler", () => {
    expect(perplexityResearch.id).toBe("perplexity.research");
    expect(typeof perplexityResearch.name).toBe("string");
    expect(perplexityResearch.auth).toEqual(["PERPLEXITY_API_KEY"]);
    expect(perplexityResearch.input).toBeInstanceOf(z.ZodType);
    expect(perplexityResearch.output).toBeInstanceOf(z.ZodType);
    expect(typeof perplexityResearch.handler).toBe("function");
  });
});

describe("perplexity.research input validation", () => {
  it("rejects an input with neither messages nor query", () => {
    expect(perplexityResearch.input.safeParse({}).success).toBe(false);
  });

  it("accepts a convenience query string", () => {
    expect(perplexityResearch.input.safeParse({ query: "what is TS?" }).success).toBe(true);
  });

  it("accepts a full messages array", () => {
    expect(
      perplexityResearch.input.safeParse({
        messages: [{ role: "user", content: "research typescript" }],
      }).success,
    ).toBe(true);
  });
});

describe("perplexity.research handler (CTX-only, injected transport)", () => {
  it("query convenience path: wraps into one message and uses sonar-deep-research", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(fakeFetch(RESEARCH_OK, captured));

    await perplexityResearch.handler(
      { query: "deep dive into TypeScript" },
      { secrets: { PERPLEXITY_API_KEY: "pplx-research-key" } },
    );

    expect(captured.url).toBe("https://api.perplexity.ai/chat/completions");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pplx-research-key");
    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.model).toBe("sonar-deep-research");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toEqual({ role: "user", content: "deep dive into TypeScript" });
  });

  it("messages path: forwards messages and metadata.messageCount equals array length", async () => {
    __setFetch(fakeFetch(RESEARCH_OK));
    const msgs = [
      { role: "system" as const, content: "Be thorough." },
      { role: "user" as const, content: "research TS" },
    ];
    const out = await perplexityResearch.handler(
      { messages: msgs },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexityResearch.output.parse(out);
    expect(parsed.metadata?.messageCount).toBe(2);
  });

  it("citation count: inline [N] markers counted; non-empty citations appends Sources block", async () => {
    __setFetch(fakeFetch(RESEARCH_OK));
    const out = await perplexityResearch.handler(
      { query: "typescript" },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexityResearch.output.parse(out);
    // RESEARCH_OK content has [1] and [2]
    expect(parsed.metadata?.citationCount).toBe(2);
    expect(parsed.content).toContain("Sources:");
    expect(parsed.content).toContain("https://ts.dev/docs");
  });

  it("strip_thinking=true: removes <think> block from content and sets thinkingStripped=true", async () => {
    const bodyWithThink = {
      choices: [
        {
          message: {
            content: "<think>internal reasoning here</think>\n\nAnswer without thinking.",
          },
        },
      ],
      citations: [],
    };
    __setFetch(fakeFetch(bodyWithThink));
    const out = await perplexityResearch.handler(
      { query: "x", strip_thinking: true },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexityResearch.output.parse(out);
    expect(parsed.content).not.toContain("<think>");
    expect(parsed.content).toContain("Answer without thinking.");
    expect(parsed.metadata?.thinkingStripped).toBe(true);
  });

  it("strip_thinking absent: <think> tags are kept in content and thinkingStripped=false", async () => {
    const bodyWithThink = {
      choices: [
        {
          message: {
            content: "<think>internal reasoning</think>\n\nFinal answer.",
          },
        },
      ],
      citations: [],
    };
    __setFetch(fakeFetch(bodyWithThink));
    const out = await perplexityResearch.handler(
      { query: "x" },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexityResearch.output.parse(out);
    expect(parsed.content).toContain("<think>");
    expect(parsed.metadata?.thinkingStripped).toBe(false);
  });

  it("throws on HTTP error 500", async () => {
    __setFetch(fakeFetch({ error: "server error" }, {}, 500));
    await expect(
      perplexityResearch.handler({ query: "x" }, { secrets: { PERPLEXITY_API_KEY: "k" } }),
    ).rejects.toThrow(/Perplexity chat\/completions HTTP 500/);
  });

  it("throws on empty content", async () => {
    __setFetch(fakeFetch({ choices: [{ message: { content: "" } }], citations: [] }));
    await expect(
      perplexityResearch.handler({ query: "x" }, { secrets: { PERPLEXITY_API_KEY: "k" } }),
    ).rejects.toThrow(/Empty response from Perplexity research/);
  });

  it("truncates content exceeding 8000 chars", async () => {
    const longContent = "A".repeat(8100);
    __setFetch(fakeFetch({ choices: [{ message: { content: longContent } }], citations: [] }));
    const out = await perplexityResearch.handler(
      { query: "x" },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexityResearch.output.parse(out);
    expect(parsed.content).toContain("[truncated for token efficiency]");
    expect(parsed.content.length).toBeLessThan(longContent.length);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// perplexity.reason
// ════════════════════════════════════════════════════════════════════════════

const REASON_OK = {
  choices: [
    {
      message: {
        content: "Step-by-step analysis of the problem.",
      },
    },
  ],
  citations: ["https://example.com/reasoning"],
};

describe("perplexity.reason descriptor shape", () => {
  it("is a ToolDescriptor with id/name/input/output/auth/handler", () => {
    expect(perplexityReason.id).toBe("perplexity.reason");
    expect(typeof perplexityReason.name).toBe("string");
    expect(perplexityReason.auth).toEqual(["PERPLEXITY_API_KEY"]);
    expect(perplexityReason.input).toBeInstanceOf(z.ZodType);
    expect(perplexityReason.output).toBeInstanceOf(z.ZodType);
    expect(typeof perplexityReason.handler).toBe("function");
  });
});

describe("perplexity.reason input validation", () => {
  it("rejects an input with neither messages nor query", () => {
    expect(perplexityReason.input.safeParse({}).success).toBe(false);
  });

  it("accepts a convenience query string", () => {
    expect(perplexityReason.input.safeParse({ query: "reason about X" }).success).toBe(true);
  });

  it("accepts a full messages array", () => {
    expect(
      perplexityReason.input.safeParse({
        messages: [{ role: "user", content: "solve this" }],
      }).success,
    ).toBe(true);
  });
});

describe("perplexity.reason handler (CTX-only, injected transport)", () => {
  it("query convenience path: wraps into one message and uses sonar-reasoning-pro", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    __setFetch(fakeFetch(REASON_OK, captured));

    await perplexityReason.handler(
      { query: "solve this problem" },
      { secrets: { PERPLEXITY_API_KEY: "pplx-reason-key" } },
    );

    expect(captured.url).toBe("https://api.perplexity.ai/chat/completions");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pplx-reason-key");
    const body = JSON.parse((captured.init?.body as string) ?? "{}");
    expect(body.model).toBe("sonar-reasoning-pro");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toEqual({ role: "user", content: "solve this problem" });
  });

  it("messages path: forwards messages and metadata.messageCount equals array length", async () => {
    __setFetch(fakeFetch(REASON_OK));
    const msgs = [
      { role: "user" as const, content: "question 1" },
      { role: "assistant" as const, content: "answer 1" },
      { role: "user" as const, content: "follow up" },
    ];
    const out = await perplexityReason.handler(
      { messages: msgs },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexityReason.output.parse(out);
    expect(parsed.metadata?.messageCount).toBe(3);
  });

  it("strip_thinking=true: removes <think> block and hasThinkingTags=false on stripped content", async () => {
    const bodyWithThink = {
      choices: [
        {
          message: {
            content: "<think>chain of thought</think>\n\nFinal answer.",
          },
        },
      ],
      citations: [],
    };
    __setFetch(fakeFetch(bodyWithThink));
    const out = await perplexityReason.handler(
      { query: "x", strip_thinking: true },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexityReason.output.parse(out);
    expect(parsed.content).not.toContain("<think>");
    expect(parsed.content).toContain("Final answer.");
    expect(parsed.metadata?.thinkingStripped).toBe(true);
    // hasThinkingTags is evaluated on the already-stripped content
    expect(parsed.metadata?.hasThinkingTags).toBe(false);
  });

  it("strip_thinking absent with think tags: thinkingStripped=false and hasThinkingTags=true", async () => {
    const bodyWithThink = {
      choices: [
        {
          message: {
            content: "<think>reasoning</think>\n\nAnswer.",
          },
        },
      ],
      citations: [],
    };
    __setFetch(fakeFetch(bodyWithThink));
    const out = await perplexityReason.handler(
      { query: "x" },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexityReason.output.parse(out);
    expect(parsed.metadata?.thinkingStripped).toBe(false);
    expect(parsed.metadata?.hasThinkingTags).toBe(true);
  });

  it("non-empty citations appends Sources block to content", async () => {
    __setFetch(fakeFetch(REASON_OK));
    const out = await perplexityReason.handler(
      { query: "x" },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexityReason.output.parse(out);
    expect(parsed.content).toContain("Sources:");
    expect(parsed.content).toContain("https://example.com/reasoning");
  });

  it("throws on HTTP error 500", async () => {
    __setFetch(fakeFetch({ error: "server error" }, {}, 500));
    await expect(
      perplexityReason.handler({ query: "x" }, { secrets: { PERPLEXITY_API_KEY: "k" } }),
    ).rejects.toThrow(/Perplexity chat\/completions HTTP 500/);
  });

  it("throws on empty content", async () => {
    __setFetch(fakeFetch({ choices: [{ message: { content: "" } }], citations: [] }));
    await expect(
      perplexityReason.handler({ query: "x" }, { secrets: { PERPLEXITY_API_KEY: "k" } }),
    ).rejects.toThrow(/Empty response from Perplexity reason/);
  });

  it("truncates content exceeding 5000 chars", async () => {
    const longContent = "B".repeat(5100);
    __setFetch(fakeFetch({ choices: [{ message: { content: longContent } }], citations: [] }));
    const out = await perplexityReason.handler(
      { query: "x" },
      { secrets: { PERPLEXITY_API_KEY: "k" } },
    );
    const parsed = perplexityReason.output.parse(out);
    expect(parsed.content).toContain("[truncated for token efficiency]");
    expect(parsed.content.length).toBeLessThan(longContent.length);
  });
});
