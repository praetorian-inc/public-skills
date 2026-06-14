/**
 * Publish-time drift guard for the BUNDLED catalog (O5 + §6.3).
 *
 * `prepublishOnly` runs this after `bundle-catalog` so a stale compiled
 * `wrapper.js` can never ship: it builds the catalog index from the bundled
 * `dist/bundled-catalog` dir and runs the SAME `assertNoDrift` the server runs
 * at boot. If any bundled wrapper's live Zod disagrees with its manifest's
 * stored `schemaHash`, this exits non-zero and the publish aborts.
 *
 * This is intentionally a check against the BUNDLED output, not the source
 * `.agentsmesh` — the published artifact is what adopters get, so the published
 * artifact is what we verify.
 */
import { existsSync } from "node:fs";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { assertNoDrift } from "../src/execute/drift.js";
import { BUNDLE_DIR } from "./bundle-catalog.js";

async function main(): Promise<void> {
  if (!existsSync(BUNDLE_DIR)) {
    throw new Error(
      `check-bundle-drift: ${BUNDLE_DIR} not found — run 'npm run bundle-catalog' first`,
    );
  }
  const index = buildIndex(BUNDLE_DIR);
  await assertNoDrift(index);
  // eslint-disable-next-line no-console -- build-script result to stderr.
  console.error(
    `[check-bundle-drift] OK — ${index.length} bundled entries, no manifest/wrapper drift`,
  );
}

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[check-bundle-drift] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
