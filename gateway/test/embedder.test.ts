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
import { GatewayError, configInvalid } from "../src/errors/to-tool-error.js";

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

  it("throws embedding_backend_error when the api endpoint returns a non-2xx response", async () => {
    // L1 retrofit: a query-time HTTP non-2xx is a runtime BACKEND failure, not a
    // config error. (Was config_invalid in P1; WS-D moves it to the new code.)
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      async json() {
        return {};
      },
    })) as unknown as typeof fetch;

    const embedder = embedderFromConfig(apiCfg, { fetchFn: fetchMock, apiKey: "sk-test" });
    await expect(embedder.embed(["alpha"])).rejects.toBeInstanceOf(GatewayError);
    await expect(embedder.embed(["alpha"])).rejects.toMatchObject({ code: "embedding_backend_error" });
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
  const localCfg = {
    backend: "local" as const,
    model: "Xenova/all-MiniLM-L6-v2",
    dimensions: 384,
    cacheDir: "./.gateway-cache/embeddings",
  };

  /**
   * Build a fake transformers.js pipeline loader returning a deterministic
   * extractor. Each input text → a `dim`-long vector [i, 0, 0, ...] so the
   * reshape-by-row logic (out.data sliced per row) is exercised without any
   * model download.
   */
  function fakeLoader(dim: number) {
    return async (_model: string) => {
      const extractor = async (texts: string[]) => {
        const n = texts.length;
        const data = new Float32Array(n * dim);
        for (let i = 0; i < n; i++) {
          data[i * dim] = i + 1; // first component distinguishes rows
        }
        return { dims: [n, dim], data };
      };
      return extractor;
    };
  }

  it("embeds texts into dimensions-long vectors via the injected loader (offline)", async () => {
    const embedder = embedderFromConfig(localCfg, { loadPipeline: fakeLoader(384) });
    const vectors = await embedder.embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(384);
    expect(vectors[1]).toHaveLength(384);
    // Row 0 starts with 1, row 1 starts with 2 — proves correct per-row slicing.
    expect(vectors[0][0]).toBe(1);
    expect(vectors[1][0]).toBe(2);
  });

  it("returns [] without loading the pipeline for an empty input list", async () => {
    const loader = vi.fn(fakeLoader(384));
    const embedder = embedderFromConfig(localCfg, { loadPipeline: loader as never });
    expect(await embedder.embed([])).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
  });

  it("memoizes the loaded pipeline across embed calls", async () => {
    const loader = vi.fn(fakeLoader(384));
    const embedder = embedderFromConfig(localCfg, { loadPipeline: loader as never });
    await embedder.embed(["a"]);
    await embedder.embed(["b"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("throws embedding_backend_error when a returned vector length != dimensions", async () => {
    // Loader yields 384-long rows but config says 3 → mismatch must fail loud.
    const embedder = embedderFromConfig(localCfg, { loadPipeline: fakeLoader(384) });
    const mismatchCfg = { ...localCfg, dimensions: 3 };
    const mismatchEmbedder = embedderFromConfig(mismatchCfg, { loadPipeline: fakeLoader(384) });
    void embedder;
    await expect(mismatchEmbedder.embed(["a"])).rejects.toBeInstanceOf(GatewayError);
    await expect(mismatchEmbedder.embed(["a"])).rejects.toMatchObject({
      code: "embedding_backend_error",
    });
  });

  it("surfaces config_invalid when the loader reports the dep absent (regression guard)", async () => {
    // The default loader throws configInvalid on a failed
    // `import("@xenova/transformers")` (dep absent). LocalEmbedder must pass that
    // GatewayError through unchanged (not remap it to embedding_backend_error),
    // telling the adopter to install it or use backend: api.
    const depAbsentLoader = async () => {
      throw configInvalid(`@xenova/transformers not installed; install it or use backend: api`);
    };
    const embedder = embedderFromConfig(localCfg, { loadPipeline: depAbsentLoader as never });
    await expect(embedder.embed(["alpha"])).rejects.toBeInstanceOf(GatewayError);
    await expect(embedder.embed(["alpha"])).rejects.toMatchObject({ code: "config_invalid" });
    await expect(embedder.embed(["alpha"])).rejects.toThrow(/@xenova\/transformers/);
  });

  it("maps a non-dep-absent loader failure to embedding_backend_error", async () => {
    // A model-load failure that is NOT dep-absence (e.g. cold cache + offline,
    // or a corrupt model) is a runtime backend fault, not a config error.
    const modelLoadFails = async () => {
      throw new Error("Could not locate model files for Xenova/all-MiniLM-L6-v2");
    };
    const embedder = embedderFromConfig(localCfg, { loadPipeline: modelLoadFails as never });
    await expect(embedder.embed(["alpha"])).rejects.toBeInstanceOf(GatewayError);
    await expect(embedder.embed(["alpha"])).rejects.toMatchObject({
      code: "embedding_backend_error",
    });
  });
});
