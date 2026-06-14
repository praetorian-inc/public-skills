/**
 * The source of truth a `wrapper.ts` exports: {@link ToolDescriptor}s plus the
 * {@link ExecContext} their handlers receive.
 *
 * `generate-manifest` reads these descriptors to emit `manifest.json`; the runner
 * (P0 group B) loads them at execute time. Zod stays the single source of truth.
 */
import { z } from "zod";

/**
 * Everything a handler is allowed to reach for at execution time.
 *
 * P0 supplies resolved `secrets`; P1 will add upstream MCP/REST client helpers.
 */
export interface ExecContext {
  /** Secrets resolved host-side (keyed by the descriptor's `auth` entries). */
  secrets: Record<string, string>;
  // P1: upstream MCP/REST client helpers
}

/**
 * A single executable tool, defined entirely in TypeScript + Zod.
 *
 * @typeParam I - validated input type (inferred from `input`)
 * @typeParam O - validated output type (inferred from `output`)
 */
export interface ToolDescriptor<I = unknown, O = unknown> {
  id: string;
  name: string;
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  auth?: string[];
  wraps?: { type: "mcp" | "rest"; server?: string; tool?: string };
  handler: (args: I, ctx: ExecContext) => Promise<O>;
}

// CTX-ONLY INJECTION CONTRACT (enforced now to keep P1 clean):
// A handler MUST obtain ALL secrets/clients from `ctx` — it must never import a
// secret, read an env var, or construct an upstream client directly. P1's
// run_code mounts these same `entry` functions inside an isolate; a handler that
// reaches outside `ctx` would still pass P0 tests but break the sandbox's
// deny-by-default egress. Lint/review for this.
