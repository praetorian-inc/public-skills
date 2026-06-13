/**
 * Load and validate `gateway.config.yaml`.
 *
 * Shape (plan: Config section):
 *   catalog.root         — path to the agentsmesh catalog (skills/ + tools/ under it)
 *   search.ranker        — keyword | semantic | hybrid (P0 implements keyword)
 *   secrets.provider     — env | 1password (P0 implements env; 1password = WS-2)
 *   secrets.onepassword  — optional 1Password sub-config (only read when
 *                          provider = 1password)
 *
 * Every section has a sane default, so an empty config file is valid.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ConfigSchema = z.object({
  catalog: z
    .object({
      root: z.string().default("./.agentsmesh"),
    })
    .default({}),
  search: z
    .object({
      ranker: z.enum(["keyword", "semantic", "hybrid"]).default("keyword"),
      // WS-3: read only when ranker = semantic | hybrid. Optional, with defaults
      // for the inner fields so `embedding: {}` is valid; the whole sub-object is
      // optional so a bare `search: { ranker: keyword }` (and an empty config)
      // stays valid.
      embedding: z
        .object({
          // O2: BOTH backends behind the Embedder seam; default = api. The api
          // backend fetches an OpenAI-compatible endpoint; local lazy-loads
          // @xenova/transformers (optionalDependency, wired in WS-D). keyword
          // never reads this sub-object. Default is `api` because the heavy local
          // dep is not in the base install — defaulting to it would make
          // semantic/hybrid require the optional dep out of the box (the api
          // backend instead fails loud asking for an endpoint, the intended path).
          backend: z.enum(["local", "api"]).default("api"),
          // local model file path OR api model id.
          model: z.string().optional(),
          // api backend only — the /v1/embeddings URL.
          endpoint: z.string().url().optional(),
          // env var NAME holding the api key (never the key itself).
          apiKeyEnv: z.string().optional(),
          // must match the vector[N] schema field the ranker builds.
          dimensions: z.number().int().positive().default(384),
          cacheDir: z.string().default("./.gateway-cache/embeddings"),
        })
        .optional(),
    })
    .default({}),
  // WS-1 (§6.1): resource caps for the run_code isolate. Optional with defaults
  // (empty config stays valid); operators can tune the memory/timeout ceiling.
  sandbox: z
    .object({
      memoryLimitMb: z.number().int().positive().default(128),
      timeoutMs: z.number().int().positive().default(5000),
    })
    .default({}),
  secrets: z
    .object({
      provider: z.enum(["env", "1password"]).default("env"),
      // WS-2: read only when provider = 1password. Optional, with defaults for
      // the inner fields so `onepassword: {}` is valid; the whole sub-object is
      // optional so a bare `secrets: { provider: 1password }` stays valid.
      onepassword: z
        .object({
          // {vault} substituted into refTemplate.
          vault: z.string().optional(),
          // O4: {vault}+{key} substituted; key = the auth string.
          refTemplate: z.string().default("op://{vault}/{key}/password"),
          // allow overriding the binary path.
          cliPath: z.string().default("op"),
        })
        .optional(),
    })
    .default({}),
}).superRefine((cfg, ctx) => {
  // WS-3 cross-refinement (§5): semantic/hybrid with the api embedding backend
  // need an endpoint to call. Express it here (JSON Schema can't), so a misconfig
  // fails at load with a clear message instead of mid-query. keyword never reads
  // embedding, so it is exempt.
  const usesEmbeddings = cfg.search.ranker === "semantic" || cfg.search.ranker === "hybrid";
  const emb = cfg.search.embedding;
  if (usesEmbeddings && emb?.backend === "api" && (emb.endpoint === undefined || emb.endpoint === "")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["search", "embedding", "endpoint"],
      message: `search.embedding.endpoint is required when ranker is "${cfg.search.ranker}" and embedding.backend is "api"`,
    });
  }
  // WS-D cross-refinement (§5): semantic/hybrid with the local embedding backend
  // need a model id/path to load (@xenova/transformers pipeline). keyword never
  // reads embedding, so it is exempt. No model registry (YAGNI) — just require
  // the field is present.
  if (usesEmbeddings && emb?.backend === "local" && (emb.model === undefined || emb.model === "")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["search", "embedding", "model"],
      message: `search.embedding.model is required when ranker is "${cfg.search.ranker}" and embedding.backend is "local"`,
    });
  }
});

/** Fully-resolved, validated gateway configuration. */
export type GatewayConfig = z.infer<typeof ConfigSchema>;

/**
 * Read, YAML-parse, and zod-validate the config at `path`.
 *
 * @throws if the file is unreadable, not valid YAML, or fails validation
 *   (e.g. an unknown ranker/provider enum value).
 */
export function loadConfig(path: string): GatewayConfig {
  const raw = readFileSync(path, "utf8");
  const data = parseYaml(raw) ?? {};
  return ConfigSchema.parse(data);
}

/**
 * Validate a partial config object through the SAME schema as {@link loadConfig}
 * (so every default + cross-refinement still applies). Used by the bin to build
 * a default config that points at the bundled catalog when no config file is
 * present — the schema's "empty config is valid" property means `{}` resolves to
 * the full default shape, and we override only `catalog.root`.
 *
 * @throws if the object fails validation.
 */
export function configFromObject(data: unknown): GatewayConfig {
  return ConfigSchema.parse(data ?? {});
}
