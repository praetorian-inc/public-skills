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
import { OAuthProviderConfigSchema, DEFAULT_OAUTH_PROVIDERS } from "./secrets/oauth-config.js";

/**
 * 1Password resolution defaults, PORTED AS DATA from the marketplace SDK
 * (`@praetorian/claude-tool-sdk/src/1password/config.ts`).
 *
 * This table is INTENTIONALLY COPIED, not imported: the gateway must not depend
 * on the SDK (constraint #1), and the published OSS artifact ships a
 * self-contained catalog. The trade-off is drift — if the marketplace renames a
 * 1Password item or vault, this copy goes stale. Mitigation: the three keys the
 * gateway catalog actually uses today (`PERPLEXITY_API_KEY`, `FEATUREBASE_API_KEY`,
 * `LINEAR_API_KEY`) are exercised by tests; the rest are forward-looking data so
 * adding those tools later needs no config change.
 */

/** Account/vault/field defaults (SDK `DEFAULT_CONFIG.account`/`.vaultName` + field `password`). */
const OP_DEFAULT_ACCOUNT = "praetorianlabs.1password.com";
const OP_DEFAULT_VAULT = "Claude Code Tools";
const OP_DEFAULT_FIELD = "password";

/**
 * Default `services` map, KEYED BY FLAT KEY (Option B — the resolver receives the
 * flat auth key and looks the service up here). Each row carries its logical
 * `service` name plus the 1Password coordinates. `vault`/`field` are per-service
 * overrides; when omitted they fall back to the top-level vault / default field.
 *
 * Flat keys follow the `{SERVICE}_API_KEY` convention the three live keys already
 * use. Mirrors SDK `DEFAULT_CONFIG.serviceItems`:
 *   - string item  → default vault `Claude Code Tools`
 *   - `{item,vault}` → explicit per-service vault
 *
 * context7 is INTENTIONALLY ABSENT: the marketplace lists a "Context7 API Key"
 * item, but the gateway's context7 wrapper is keyless (`auth: []`), so it never
 * resolves a secret and needs no row here.
 *
 * `LINEAR_API_KEY` is also absent: the marketplace SDK has no 1Password item for
 * linear, so inventing an item title would be unverified data. Linear still
 * resolves under the env provider via the flat-key fast-path; under the 1Password
 * provider an unmapped key fails loud with `config_invalid` (the operator never
 * mapped it) — the intended taxonomy, not a silent default.
 */
const OP_DEFAULT_SERVICES = {
  // Core services (default "Claude Code Tools" vault)
  CURRENTS_API_KEY: { service: "currents", item: "Currents API Key" },
  PERPLEXITY_API_KEY: { service: "perplexity", item: "Perplexity API Key" },
  SHODAN_API_KEY: { service: "shodan", item: "Shodan API Key" },
  FEATUREBASE_API_KEY: { service: "featurebase", item: "Featurebase API Key" },
  SEMRUSH_API_KEY: { service: "semrush", item: "Semrush API Key" },
  HUBSPOT_API_KEY: { service: "hubspot", item: "HubSpot API Key" },
  HUBSPOT_WEBHOOKS_API_KEY: { service: "hubspot-webhooks", item: "HubSpot Dev API Key" },
  WORDPRESS_API_KEY: { service: "wordpress", item: "WordPress Access Token" },
  WPENGINE_API_KEY: { service: "wpengine", item: "WPEngine Authorization" },
  // IT services (explicit vault override)
  N8N_API_KEY: { service: "n8n", item: "n8n sales api key", vault: "Claude Tools IT" },
  SIMPLEMDM_API_KEY: { service: "simplemdm", item: "SimpleMDM API Key", vault: "Claude Tools IT" },
  CLOUDFLARE_API_KEY: {
    service: "cloudflare",
    item: "Cloudflare Wordpress API Key",
    vault: "Claude Tools IT",
  },
  SIIT_API_KEY: { service: "siit", item: "Siit API Key (IT)", vault: "Information Technology" },
} as const;

/** Zod schema for a single `services` row. */
const ServiceItemSchema = z.object({
  /** Logical service name — informational / greppable; the lookup key is the flat key. */
  service: z.string().optional(),
  /** 1Password item title (required). */
  item: z.string(),
  /** Per-service vault; falls back to `OP_VAULT_NAME` / top-level `vault` default. */
  vault: z.string().optional(),
  /** Per-service field; falls back to top-level `field` default. */
  field: z.string().optional(),
});

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
      // WS-2: read only when provider = 1password. Defaults for the inner fields
      // so `onepassword: {}` is valid; the sub-object itself defaults to `{}` so a
      // bare `secrets: { provider: 1password }` materializes those inner defaults
      // (incl. the ported `services` table) rather than resolving to undefined.
      onepassword: z
        .object({
          // 1Password account (the `op --account` shorthand). Default ported from
          // the SDK; env override OP_ACCOUNT is applied in the provider, not here,
          // so config stays pure/declarative (mirrors how `op` reads env).
          account: z.string().default(OP_DEFAULT_ACCOUNT),
          // DEFAULT vault. Per-service `services[*].vault` overrides this; the
          // OP_VAULT_NAME env override is layered on top in the provider.
          vault: z.string().default(OP_DEFAULT_VAULT),
          // DEFAULT field within an item. Per-service `services[*].field` overrides.
          field: z.string().default(OP_DEFAULT_FIELD),
          // {vault}/{item}/{field} substituted; back-compat knob for adopters that
          // need a non-standard ref shape.
          refTemplate: z.string().default("op://{vault}/{item}/{field}"),
          // allow overriding the binary path.
          cliPath: z.string().default("op"),
          // Service map keyed by FLAT KEY (the auth entry). Defaults to the ported
          // marketplace table so a no-config 1password boot resolves the catalog's
          // live services out of the box.
          services: z.record(z.string(), ServiceItemSchema).default(OP_DEFAULT_SERVICES),
        })
        // `.default({})` (not `.optional()`): a bare `secrets: { provider: 1password }`
        // must materialize the inner defaults (esp. the ported `services` table) so a
        // no-config 1password boot resolves the catalog's live services. With
        // `.optional()` the object stayed `undefined`, the services default never fired,
        // and every keyed tool threw `config_invalid` (HIGH-1).
        .default({}),
      // M1 — per-flat-key strategy override. Absent key ⇒ { type: api-key, store: <provider> }
      // (today's behavior). `.optional()` (NOT defaulted) so absent ⇒ no dispatch wrapping.
      auth: z
        .record(
          z.string(), // flat key, e.g. LINEAR_API_KEY
          z.object({
            type: z.enum(["env", "api-key", "oauth"]),
            store: z.enum(["claude-oauth", "1password"]).optional(), // oauth only
            provider: z.string().optional(), // oauth only → secrets.oauth.<provider>
          }),
        )
        .optional(),
      // M1 — OAuth provider registry; ships the default `linear` row (no fill-in needed).
      // `.default(...)` so an empty config materializes the `linear` row (parity with
      // how `onepassword.services` defaults).
      // Cast: DEFAULT_OAUTH_PROVIDERS is `as const` (deep-readonly so the test can
      // assert exact literals); Zod's `.default()` wants the mutable input type.
      oauth: z
        .record(z.string(), OAuthProviderConfigSchema)
        .default(DEFAULT_OAUTH_PROVIDERS as unknown as Record<string, z.input<typeof OAuthProviderConfigSchema>>),
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
  // WS-2 cross-refinement (§3): when 1Password is the active provider, every
  // declared service row must carry a non-empty `item` — an empty item would
  // build a malformed `op://{vault}//{field}` ref. The empty config stays valid
  // because `services` defaults to the ported table (all rows have an item).
  if (cfg.secrets.provider === "1password") {
    const services = cfg.secrets.onepassword?.services ?? {};
    for (const [flatKey, row] of Object.entries(services)) {
      if (row.item.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["secrets", "onepassword", "services", flatKey, "item"],
          message: `secrets.onepassword.services.${flatKey}.item must be non-empty`,
        });
      }
    }
  }
  // M1 cross-refinement: every secrets.auth row of type "oauth" must name a
  // provider that exists in secrets.oauth. Caught at load (config_invalid) so a
  // misconfig fails early instead of mid-resolve, naming only the key/provider.
  const authMap = cfg.secrets.auth ?? {};
  for (const [flatKey, row] of Object.entries(authMap)) {
    if (row.type === "oauth") {
      if (!row.provider) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["secrets", "auth", flatKey, "provider"],
          message: `secrets.auth.${flatKey}.provider is required when type is "oauth"`,
        });
      } else if (cfg.secrets.oauth[row.provider] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["secrets", "auth", flatKey, "provider"],
          message: `secrets.auth.${flatKey}.provider "${row.provider}" is not defined in secrets.oauth`,
        });
      }
    }
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
