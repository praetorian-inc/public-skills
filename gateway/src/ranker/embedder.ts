/**
 * The embedding backend seam for the semantic/hybrid rankers.
 *
 * Orama does NOT compute embeddings — vectors are precomputed and passed in. The
 * {@link Embedder} seam turns description/query text into vectors behind one of
 * two backends (D5, O2 RESOLVED — implement BOTH; default = `api`):
 *
 *   - `api`   (default): POST `{ input, model }` to an OpenAI-compatible
 *     `/v1/embeddings` endpoint via global `fetch`. The API key is read from the
 *     env var NAMED by `apiKeyEnv` — never stored in config. No model dependency.
 *   - `local`: lazily `await import("@xenova/transformers")` ONLY when first
 *     used, so an `api` (or keyword) install never pulls the heavy optional dep
 *     (~259M incl. onnxruntime + sharp). It loads the model named by `cfg.model`
 *     (e.g. `Xenova/all-MiniLM-L6-v2` → 384-dim), caching the model weights under
 *     a sibling of `cfg.cacheDir`; with `env.allowRemoteModels=false` it runs
 *     fully OFFLINE after a warm cache. If the dep is absent, a clean
 *     `config_invalid` is thrown (NOT a crash); a load/run failure or a
 *     dimension mismatch throws `embedding_backend_error`.
 *
 * keyword ranking uses NO embedder. Only semantic/hybrid construct one.
 */
import { GatewayError, configInvalid, embeddingBackendError } from "../errors/to-tool-error.js";

/** Turns text into embedding vectors (one vector per input string, in order). */
export interface Embedder {
  /** Embed `texts`; returns one vector per text. `[]` in → `[]` out (no call). */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * The `search.embedding` config slice an embedder needs.
 *
 * Matches the optional sub-object added to `config.ts` (`backend` + the api/local
 * fields). Declared here (not imported from config) so the embedder seam has no
 * dependency on the YAML loader.
 */
export interface EmbeddingConfig {
  backend: "local" | "api";
  model?: string;
  endpoint?: string;
  apiKeyEnv?: string;
  dimensions: number;
  cacheDir: string;
}

/**
 * A loaded feature-extraction pipeline (the transformers.js `extractor`).
 *
 * Mirrors the verified shape: `extractor(texts, { pooling, normalize })` returns
 * a tensor-like `{ dims: [N, D], data: Float32Array }` (length `N*D`).
 */
export type FeatureExtractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array | number[] }>;

/**
 * Loads the feature-extraction pipeline for `model`, applying `allowRemoteModels`
 * (false = offline after a warm cache) and the model-weight `cacheDir`. The real
 * impl lazy-imports `@xenova/transformers`; tests inject a fake.
 */
export type PipelineLoader = (
  model: string,
  opts: { allowRemoteModels: boolean; cacheDir?: string },
) => Promise<FeatureExtractor>;

/** Test/DI seam: inject `fetch`, the resolved api key, and/or the pipeline loader so tests stay offline. */
export interface EmbedderDeps {
  /** Override `globalThis.fetch` (tests inject a stub). */
  fetchFn?: typeof fetch;
  /** Override the resolved api key (otherwise read from `process.env[apiKeyEnv]`). */
  apiKey?: string;
  /**
   * Override the local pipeline loader (tests inject a fake so no model is
   * downloaded). Defaults to lazy-importing `@xenova/transformers`.
   */
  loadPipeline?: PipelineLoader;
  /**
   * `local` backend: allow downloading the model from the hub on a cache miss.
   * Defaults to `true` (first run downloads; later runs reuse the cache).
   * Set `false` to require a warm cache and prove fully-offline operation.
   */
  allowRemoteModels?: boolean;
}

/** Minimal shape of an OpenAI-compatible `/v1/embeddings` response. */
interface EmbeddingsResponse {
  data: { embedding: number[] }[];
}

/**
 * Build the concrete {@link Embedder} for `cfg.backend`.
 *
 * For `api`, the endpoint and api key are validated up-front (startup-time
 * `config_invalid`) so a misconfiguration fails loud at boot, not mid-query.
 *
 * @throws {@link GatewayError} (`config_invalid`) — api backend missing
 *   `endpoint`, or the env var named by `apiKeyEnv` is unset.
 */
export function embedderFromConfig(cfg: EmbeddingConfig, deps: EmbedderDeps = {}): Embedder {
  switch (cfg.backend) {
    case "api":
      return new ApiEmbedder(cfg, deps);
    case "local":
      return new LocalEmbedder(cfg, deps);
    default:
      // The config enum constrains this to api|local; an unknown value here is a
      // config error, not an internal bug.
      throw configInvalid(`unknown embedding backend "${cfg.backend as string}" (expected: api | local)`);
  }
}

/** HTTP embedder against an OpenAI-compatible `/v1/embeddings` endpoint. */
class ApiEmbedder implements Embedder {
  readonly #endpoint: string;
  readonly #model: string | undefined;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(cfg: EmbeddingConfig, deps: EmbedderDeps) {
    if (cfg.endpoint === undefined || cfg.endpoint === "") {
      throw configInvalid(
        `embedding backend "api" requires search.embedding.endpoint (an OpenAI-compatible /v1/embeddings URL)`,
      );
    }
    const apiKey = deps.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined);
    if (apiKey === undefined || apiKey === "") {
      throw configInvalid(
        cfg.apiKeyEnv
          ? `embedding api key env var "${cfg.apiKeyEnv}" is unset`
          : `embedding backend "api" requires search.embedding.apiKeyEnv (the env var NAME holding the key)`,
      );
    }
    this.#endpoint = cfg.endpoint;
    this.#model = cfg.model;
    this.#apiKey = apiKey;
    this.#fetch = deps.fetchFn ?? globalThis.fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.#model }),
    });

    if (!res.ok) {
      // L1 retrofit: a query-time HTTP non-2xx is a RUNTIME backend failure, not
      // a config error. Surface only the status — the response body may echo the
      // request and is not needed for the coded error.
      throw embeddingBackendError(`embedding endpoint returned ${res.status}`);
    }

    const json = (await res.json()) as EmbeddingsResponse;
    return json.data.map((d) => d.embedding);
  }
}

/** Default loader: lazy-import `@xenova/transformers` and build the pipeline. */
const defaultPipelineLoader: PipelineLoader = async (model, opts) => {
  // The dep is intentionally an optionalDependency (heavy: ~259M). Lazy-import
  // it; ONLY the import failing means the dep is genuinely absent → a clean
  // config_invalid. A later pipeline/model-load failure is a runtime backend
  // fault (mapped to embedding_backend_error by the caller), NOT a config error.
  let mod: {
    pipeline: (task: string, model: string) => Promise<FeatureExtractor>;
    env: { allowRemoteModels: boolean; cacheDir?: string };
  };
  try {
    mod = (await import("@xenova/transformers" as string)) as typeof mod;
  } catch {
    throw configInvalid(`@xenova/transformers not installed; install it or use backend: api`);
  }
  // Offline control + model-weight cache location (separate from the vector
  // EmbeddingCache). Set before the pipeline loads so a cache-only run is honoured.
  mod.env.allowRemoteModels = opts.allowRemoteModels;
  if (opts.cacheDir !== undefined) mod.env.cacheDir = opts.cacheDir;
  return mod.pipeline("feature-extraction", model);
};

/**
 * Local embedder via the optional `@xenova/transformers` dep, lazy-imported on
 * first use so it is never required by api/keyword installs.
 *
 * The model named by `cfg.model` is loaded once (memoized on the instance);
 * `embed` runs mean-pooled, L2-normalized feature extraction and reshapes the
 * flat `Float32Array` into one `dimensions`-long vector per input. Each vector's
 * length is asserted against `cfg.dimensions` so a model/dimension mismatch fails
 * loud (`embedding_backend_error`) instead of silently corrupting the index.
 *
 * If the optional dep is absent, `embed` throws a clean `config_invalid` telling
 * the adopter to install it or switch to `backend: api`.
 */
class LocalEmbedder implements Embedder {
  readonly #cfg: EmbeddingConfig;
  readonly #loadPipeline: PipelineLoader;
  readonly #allowRemoteModels: boolean;
  #extractor: Promise<FeatureExtractor> | undefined;

  constructor(cfg: EmbeddingConfig, deps: EmbedderDeps = {}) {
    this.#cfg = cfg;
    this.#loadPipeline = deps.loadPipeline ?? defaultPipelineLoader;
    this.#allowRemoteModels = deps.allowRemoteModels ?? true;
  }

  /** Load the pipeline once; reuse it across calls. */
  async #extractorOnce(): Promise<FeatureExtractor> {
    if (this.#extractor === undefined) {
      const model = this.#cfg.model;
      if (model === undefined || model === "") {
        // Defended by the config superRefine, but guard here too (the seam can be
        // constructed directly): a genuine misconfiguration, not a runtime fault.
        throw configInvalid(`local embedding backend requires search.embedding.model`);
      }
      this.#extractor = this.#loadPipeline(model, {
        allowRemoteModels: this.#allowRemoteModels,
        // Model weights cache in a sibling `models/` dir of the vector cache.
        cacheDir: `${this.#cfg.cacheDir}/../models`,
      }).catch((e: unknown) => {
        // Reset so a later call can retry. The loader already classifies a
        // dep-absent failure as a GatewayError (config_invalid) — pass that
        // through unchanged; any other load failure is a runtime backend fault.
        this.#extractor = undefined;
        if (e instanceof GatewayError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw embeddingBackendError(`failed to load local embedding model: ${msg}`);
      });
    }
    return this.#extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.#extractorOnce();

    let out: { dims: number[]; data: Float32Array | number[] };
    try {
      out = await extractor(texts, { pooling: "mean", normalize: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw embeddingBackendError(`local embedding run failed: ${msg}`);
    }

    const dims = this.#cfg.dimensions;
    // The model's native vector width is dims[last]; reshape uses it, and a
    // mismatch with the configured `dimensions` corrupts the orama vector[N]
    // schema + the cache, so fail loud.
    const modelDim = out.dims[out.dims.length - 1];
    if (modelDim !== dims) {
      throw embeddingBackendError(
        `local embedding model produced ${modelDim}-dim vectors; config dimensions is ${dims} (model/dimensions mismatch)`,
      );
    }
    const data = out.data;
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      vectors.push(Array.from(data.slice(i * dims, (i + 1) * dims)));
    }
    return vectors;
  }
}
