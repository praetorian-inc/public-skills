/**
 * Group G — embedder seam coverage.
 *
 * `embedderFromConfig(embeddingCfg)` returns ONE concrete impl per `backend`:
 *   - `api`   → an HTTP embedder that POSTs to an OpenAI-compatible endpoint.
 *   - `local` → a lazy `@orama/plugin-embeddings`-backed embedder (deferred:
 *               throws config_invalid if the optional dep is absent).
 *
 * The `api` backend is exercised with an injected `fetch` so tests stay offline.
 */
import { describe, it, expect, vi } from "vitest";
import { embedderFromConfig } from "../src/ranker/embedder.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

const apiCfg = {
  backend: "api" as const,
  model: "text-embedding-3-small",
  endpoint: "https://api.example.com/v1/embeddings",
  apiKeyEnv: "EMBED_API_KEY",
  dimensions: 3,
  cacheDir: "./.gateway-cache/embeddings",
};

describe("embedderFromConfig — api backend", () => {
  it("POSTs {input, model} to the endpoint and returns the embedding vectors", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] };
      },
    })) as unknown as typeof fetch;

    const embedder = embedderFromConfig(apiCfg, { fetchFn: fetchMock, apiKey: "sk-test" });
    const vectors = await embedder.embed(["alpha", "beta"]);

    expect(vectors).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(apiCfg.endpoint);
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({ input: ["alpha", "beta"], model: "text-embedding-3-small" });
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  it("returns [] without calling fetch for an empty input list", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const embedder = embedderFromConfig(apiCfg, { fetchFn: fetchMock, apiKey: "sk-test" });

    expect(await embedder.embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws config_invalid when the api endpoint returns a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      async json() {
        return {};
      },
    })) as unknown as typeof fetch;

    const embedder = embedderFromConfig(apiCfg, { fetchFn: fetchMock, apiKey: "sk-test" });
    await expect(embedder.embed(["alpha"])).rejects.toBeInstanceOf(GatewayError);
    await expect(embedder.embed(["alpha"])).rejects.toMatchObject({ code: "config_invalid" });
  });

  it("reads the api key from the env var named by apiKeyEnv (never from config)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: [{ embedding: [1, 2, 3] }] };
      },
    })) as unknown as typeof fetch;

    process.env.EMBED_API_KEY = "sk-from-env";
    try {
      // No apiKey override → must read process.env[apiKeyEnv].
      const embedder = embedderFromConfig(apiCfg, { fetchFn: fetchMock });
      await embedder.embed(["alpha"]);
      const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = (init as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toBe("Bearer sk-from-env");
    } finally {
      delete process.env.EMBED_API_KEY;
    }
  });

  it("throws config_invalid when the api key env var is unset", () => {
    delete process.env.EMBED_API_KEY;
    expect(() => embedderFromConfig(apiCfg, { fetchFn: vi.fn() as unknown as typeof fetch })).toThrow(
      GatewayError,
    );
    try {
      embedderFromConfig(apiCfg, { fetchFn: vi.fn() as unknown as typeof fetch });
    } catch (e) {
      expect((e as GatewayError).code).toBe("config_invalid");
    }
  });

  it("throws config_invalid when the api endpoint is missing", () => {
    const noEndpoint = { ...apiCfg, endpoint: undefined };
    expect(() =>
      embedderFromConfig(noEndpoint, { apiKey: "sk-test", fetchFn: vi.fn() as unknown as typeof fetch }),
    ).toThrow(GatewayError);
    try {
      embedderFromConfig(noEndpoint, { apiKey: "sk-test", fetchFn: vi.fn() as unknown as typeof fetch });
    } catch (e) {
      expect((e as GatewayError).code).toBe("config_invalid");
    }
  });
});

describe("embedderFromConfig — local backend", () => {
  it("throws a clear config_invalid when @orama/plugin-embeddings is absent", async () => {
    const localCfg = { ...apiCfg, backend: "local" as const, endpoint: undefined };
    // The local backend lazy-imports the optional dep on first embed; with the
    // dep absent it must surface a clean coded error, not an unhandled throw.
    const embedder = embedderFromConfig(localCfg);
    await expect(embedder.embed(["alpha"])).rejects.toBeInstanceOf(GatewayError);
    await expect(embedder.embed(["alpha"])).rejects.toMatchObject({ code: "config_invalid" });
    await expect(embedder.embed(["alpha"])).rejects.toThrow(/@orama\/plugin-embeddings/);
  });
});
