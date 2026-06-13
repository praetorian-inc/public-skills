/**
 * Load and validate `gateway.config.yaml`.
 *
 * Shape (plan: Config section):
 *   catalog.root         — path to the agentsmesh catalog (skills/ + tools/ under it)
 *   search.ranker        — keyword | semantic | hybrid (P0 implements keyword)
 *   secrets.provider     — env | 1password (P0 implements env)
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
    })
    .default({}),
  secrets: z
    .object({
      provider: z.enum(["env", "1password"]).default("env"),
    })
    .default({}),
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
