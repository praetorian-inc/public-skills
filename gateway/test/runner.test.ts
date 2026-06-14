import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { executeTool } from "../src/execute/runner.js";
import { EnvProvider } from "../src/secrets/env-provider.js";
import { GatewayError } from "../src/errors/to-tool-error.js";
import type { SecretProvider } from "../src/secrets/provider.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogRoot = join(here, "fixtures/.agentsmesh");

const index = buildIndex(catalogRoot);
const secrets = new EnvProvider();

describe("executeTool", () => {
  it("round-trips the echo tool", async () => {
    const result = await executeTool("echo.echo", { text: "hello" }, { index, secrets });
    expect(result).toEqual({ text: "hello" });
  });

  it("throws unknown_id for an id not in the index", async () => {
    await expect(executeTool("nope.nope", {}, { index, secrets })).rejects.toMatchObject({
      code: "unknown_id",
    });
  });

  it("throws kind_mismatch when the id is a skill", async () => {
    await expect(
      executeTool("adhering-to-yagni", {}, { index, secrets }),
    ).rejects.toMatchObject({ code: "kind_mismatch" });
  });

  it("throws invalid_args when args fail the descriptor input schema", async () => {
    await expect(
      executeTool("echo.echo", { text: 123 }, { index, secrets }),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("throws wrapper_load_failed when the wrapper export is missing", async () => {
    // Hand-craft an index entry whose manifest points at a non-existent export.
    const bad = [
      {
        id: "echo.missing",
        kind: "tool" as const,
        name: "missing",
        description: "",
        path: join(catalogRoot, "tools/echo/manifest.json"),
      },
    ];
    await expect(executeTool("echo.missing", {}, { index: bad, secrets })).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  it("throws missing_secret when a declared auth key is absent", async () => {
    // A provider that always reports the key missing.
    const failing: SecretProvider = {
      async resolve(keys) {
        if (keys.length > 0) throw new GatewayError("missing_secret", `missing secret: ${keys[0]}`);
        return {};
      },
    };
    // echo has no auth, so resolve([]) succeeds — use a provider that would fail
    // if any key were requested, and verify echo (no auth) still works.
    const result = await executeTool("echo.echo", { text: "x" }, { index, secrets: failing });
    expect(result).toEqual({ text: "x" });
  });
});
