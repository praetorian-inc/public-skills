/**
 * Fixture tool for WS-1 Group B: a tool that DECLARES `auth`, used to prove the
 * secret invariant (a) — the secret is resolved host-side and consumed by the
 * host-side handler, and is never readable inside the isolate.
 *
 * The handler returns ONLY whether the secret was present host-side (a boolean),
 * never the secret value itself (never leak).
 */
import { z } from "zod";
import type { ToolDescriptor } from "../../../../../src/execute/descriptor.js";

const input = z.object({ text: z.string() });
const output = z.object({ text: z.string(), secretSeen: z.boolean() });

export const secretEcho: ToolDescriptor<z.infer<typeof input>, z.infer<typeof output>> = {
  id: "secretecho.secretecho",
  name: "secretecho",
  description: "Echo text; reports (boolean only) whether TEST_SECRET resolved host-side.",
  auth: ["TEST_SECRET"],
  handler: async ({ text }, ctx) => ({
    text,
    secretSeen: typeof ctx.secrets.TEST_SECRET === "string" && ctx.secrets.TEST_SECRET.length > 0,
  }),
  input,
  output,
};
