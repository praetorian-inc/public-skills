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
          // O2: BOTH backends behind the Embedder seam; default = local. The api
          // backend fetches an OpenAI-compatible endpoint; local lazy-loads
          // @orama/plugin-embeddings. keyword never reads this sub-object.
          backend: z.enum(["local", "api"]).default("local"),
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
