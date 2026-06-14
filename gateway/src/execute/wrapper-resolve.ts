/**
 * Shared wrapper-file resolution for the runner and the boot-time drift guard.
 *
 * Both the live executor ({@link ../execute/runner.ts}) and the startup drift
 * check ({@link ../execute/drift.ts}) MUST resolve the same wrapper file and the
 * same export, or `get_schema` (static manifest) and `execute` (live Zod) could
 * silently diverge. Keeping the resolution in one module is the single source of
 * truth for that (B2).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the wrapper module file in `serviceDir`, preferring the compiled
 * `wrapper.js` over the `wrapper.ts` source.
 *
 * A published gateway runs under plain Node (`node dist/index.js`), which has no
 * TypeScript loader — so catalog wrappers must be SERVED as compiled `.js`, and
 * `.js` is therefore preferred. The `.ts` fallback exists ONLY so dev/test
 * (tsx/vitest, which can import TS) can run against un-compiled wrapper sources.
 * A stale `.js` shadowing a newer `.ts` cannot serve a wrong schema silently:
 * the boot drift guard recomputes the live hash from whatever this resolves and
 * refuses to start on mismatch.
 *
 * @returns the absolute wrapper path, or `undefined` when neither file exists.
 */
export function resolveWrapperPath(serviceDir: string): string | undefined {
  const js = join(serviceDir, "wrapper.js");
  if (existsSync(js)) return js;
  const ts = join(serviceDir, "wrapper.ts");
  if (existsSync(ts)) return ts;
  return undefined;
}

/** `"wrapper.js#echo"` → `"echo"`; an entry with no `#` is the export name itself. */
export function exportFromEntry(entry: string): string {
  const hash = entry.indexOf("#");
  return hash === -1 ? entry : entry.slice(hash + 1);
}
