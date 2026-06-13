/**
 * P0 sample tool: a credential-free `echo` descriptor.
 *
 * Imports the real {@link ToolDescriptor} contract from the gateway source so it
 * exercises the actual interface. `execute` (Group C) drives this end-to-end
 * without any upstream service or secrets.
 */
import { z } from "zod";
import type { ToolDescriptor } from "../../../../../src/execute/descriptor.js";

const input = z.object({ text: z.string() });
const output = z.object({ text: z.string() });

export const echo: ToolDescriptor<z.infer<typeof input>, z.infer<typeof output>> = {
  id: "echo.echo",
  name: "echo",
  description: "Echo the provided text back unchanged.",
  input,
  output,
  handler: async ({ text }) => ({ text }),
};
