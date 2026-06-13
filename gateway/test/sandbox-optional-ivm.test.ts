/**
 * WS-B / O9 — graceful degradation when the OPTIONAL `isolated-vm` native dep
 * is absent.
 *
 * `isolated-vm` is an optionalDependency (package.json) and is lazy-imported on
 * the first `run_code` call. If the native build was skipped/failed, the module
 * is genuinely absent and the dynamic `import("isolated-vm")` rejects with
 * `ERR_MODULE_NOT_FOUND`. The sandbox MUST map that to a CLEAN coded error
 * (`config_invalid`) — never an opaque `internal_error` — so the four
 * non-run_code tools keep working and `run_code` fails informatively.
 *
 * We mock the module so its import throws the module-not-found error, exactly as
 * Node does when the package is missing. This file mocks at module scope, so it
 * lives alone (the other sandbox tests need the real module).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Simulate the native module being absent. Node, when the package is missing,
// throws ERR_MODULE_NOT_FOUND from the dynamic `import("isolated-vm")` itself.
// A vi.mock factory that *throws* is wrapped by Vitest in its own error, which
// would not reproduce the raw `.code` the production catch inspects. Instead we
// return a module whose `default` access throws the genuine Node-shaped error —
// so `(await import("isolated-vm")).default` throws the real ERR_MODULE_NOT_FOUND
// inside the sandbox's try, exactly as a missing native module would.
vi.mock("isolated-vm", () => ({
  get default(): never {
    const err = new Error("Cannot find module 'isolated-vm'") as NodeJS.ErrnoException;
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  },
}));

import { buildIndex } from "../src/catalog/catalog-index.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { Sandbox } from "../src/sandbox/sandbox.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogRoot = join(here, "fixtures/.agentsmesh");

let index: ReturnType<typeof buildIndex>;

beforeAll(() => {
  index = buildIndex(catalogRoot);
});

describe("run_code degrades cleanly when isolated-vm is absent (O9)", () => {
  it("maps the missing native module to config_invalid (not internal_error)", async () => {
    const sandbox = new Sandbox({ index, secrets: new EnvProvider() });
    await expect(sandbox.run(`(() => 1 + 1)()`)).rejects.toMatchObject({
      code: "config_invalid",
    });
  });

  it("the error message names isolated-vm and tells the user the other tools still work", async () => {
    const sandbox = new Sandbox({ index, secrets: new EnvProvider() });
    try {
      await sandbox.run(`(() => 1)()`);
      throw new Error("expected run to reject");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("isolated-vm");
      expect(msg).toMatch(/search_capabilities|get_schema|resolve_skill|execute/);
    }
  });
});
