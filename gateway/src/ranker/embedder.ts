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
 *   - `local`: lazily `await import("@orama/plugin-embeddings")` ONLY when first
 *     used, so an `api` (or keyword) install never pulls the heavy optional dep.
 *     If the dep is absent, a clean `config_invalid` is thrown (deferred — see
 *     the deviation note in the implementation log), NOT a crash.
 *
 * keyword ranking uses NO embedder. Only semantic/hybrid construct one.
 */
import { configInvalid } from "../errors/to-tool-error.js";

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

/** Test/DI seam: inject `fetch` and/or the resolved api key so tests stay offline. */
export interface EmbedderDeps {
  /** Override `globalThis.fetch` (tests inject a stub). */
  fetchFn?: typeof fetch;
  /** Override the resolved api key (otherwise read from `process.env[apiKeyEnv]`). */
  apiKey?: string;
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
      return new LocalEmbedder(cfg);
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
      // Surface only the status — the response body may echo the request and is
      // not needed for the coded error.
      throw configInvalid(`embedding endpoint returned ${res.status}`);
    }

    const json = (await res.json()) as EmbeddingsResponse;
    return json.data.map((d) => d.embedding);
  }
}

/**
 * Local embedder via the optional `@orama/plugin-embeddings` dep, lazy-imported
 * on first use so it is never required by api/keyword installs.
 *
 * DEFERRED: the optional dep is not part of the base install. If it is absent,
 * `embed` throws a clean `config_invalid` telling the adopter to install it or
 * switch to `backend: api`. (See the deviation note in the implementation log.)
 */
class LocalEmbedder implements Embedder {
  readonly #cfg: EmbeddingConfig;

  constructor(cfg: EmbeddingConfig) {
    this.#cfg = cfg;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // The dep is intentionally NOT in package.json (base install stays the P0
    // five). Lazy-import it; absence → clean coded error, never a crash.
    try {
      await import("@orama/plugin-embeddings" as string);
    } catch {
      throw configInvalid(
        `local embedding backend requires @orama/plugin-embeddings; install it or use backend: api`,
      );
    }
    // Reaching here means the dep IS installed but wiring it is out of P1 scope
    // (default backend is `api`). Fail loud rather than silently returning wrong
    // vectors. Implementer note: wire the plugin here when a local model is
    // actually adopted (P2). `#cfg.model`/`#cfg.dimensions` would feed it.
    void this.#cfg;
    throw configInvalid(
      `local embedding backend is not wired in P1 (default is backend: api); use backend: api`,
    );
  }
}
