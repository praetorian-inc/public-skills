/**
 * Bundle the served agentsmesh catalog into the package tarball (O5).
 *
 * WHY THIS EXISTS
 * ---------------
 * The Praetorian catalog lives OUTSIDE the `gateway/` package, at
 * `public-skills/.agentsmesh`. O5 (P2 plan) requires the published
 * `@praetorian/capability-gateway` package to ship that catalog so that a bare
 * `npx @praetorian/capability-gateway` works out of the box with no config and
 * no separate catalog. Because the catalog is outside the package root, npm
 * cannot pack it directly — it must be COPIED into the package's own tree at
 * pack/build time. This script does that copy.
 *
 * WHERE IT LANDS
 * --------------
 * Output dir: `dist/bundled-catalog/` (NOT `dist/catalog/`). `tsc` already emits
 * the compiled `src/catalog/` module to `dist/catalog/*.js`; a separate
 * `bundled-catalog/` dir keeps the runtime catalog DATA (skills/, tools/) fully
 * disjoint from compiled module CODE, so the `files`/pack/drift assertions stay
 * crisp and the default-resolution path (computed relative to `dist/index.js`)
 * is unambiguous.
 *
 * WHAT IT INCLUDES / EXCLUDES (SF-1)
 * ----------------------------------
 *   include  skills/**                              (prose skills, verbatim)
 *            tools/<svc>/manifest.json              (the drift-checked manifest)
 *            tools/<svc>/wrapper.js                 (COMPILED only — bare Node
 *                                                    has no TS loader: SF-1)
 *            package.json {"type":"module"}         (so Node treats wrapper.js as ESM)
 *   exclude  node_modules + the dev-only zod symlink (the installed package
 *            dedupes zod via its own dependency — no symlink needed at runtime)
 *            every wrapper.ts                       (TS source never served)
 *            tsconfig*.json                         (build config, not runtime)
 *            *.test.* / __tests__                   (tests never ship)
 *
 * IDEMPOTENT: the output dir is wiped and re-created on every run, so a stale
 * `wrapper.js` can never linger. `prepublishOnly` re-runs the drift guard
 * against THIS bundled output (see scripts/check-bundle-drift.ts) so a stale
 * compiled wrapper can never be published.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const gatewayRoot = join(here, ".."); // scripts/ -> gateway/

/** Source catalog (repo-root .agentsmesh) and the bundle destination. */
export const SOURCE_CATALOG = join(gatewayRoot, "..", ".agentsmesh");
export const BUNDLE_DIR = join(gatewayRoot, "dist", "bundled-catalog");

/**
 * Copy the served catalog from `sourceRoot` into `destRoot`, applying the SF-1
 * include/exclude rules above. Returns the destination path.
 *
 * Exported so tests can drive it against the real source catalog (the test
 * setup calls this to populate the bundle before asserting on its contents).
 */
export function bundleCatalog(sourceRoot = SOURCE_CATALOG, destRoot = BUNDLE_DIR): string {
  if (!existsSync(sourceRoot)) {
    throw new Error(`bundle-catalog: source catalog not found at ${sourceRoot}`);
  }

  // Wipe-and-recreate so a stale wrapper.js can never survive a rebuild.
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(destRoot, { recursive: true });

  copySkills(join(sourceRoot, "skills"), join(destRoot, "skills"));
  copyTools(join(sourceRoot, "tools"), join(destRoot, "tools"));

  // ESM marker so bare Node treats the wrappers as ES modules (SF-1). The
  // bundled catalog ships no code of its own and is never published on its own.
  writeFileSync(
    join(destRoot, "package.json"),
    JSON.stringify(
      {
        "//":
          "Bundled Praetorian catalog for @praetorian/capability-gateway. ESM marker only " +
          "so compiled tools/<svc>/wrapper.js load as ES modules; no code of its own.",
        name: "@praetorian/capability-gateway-bundled-catalog",
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return destRoot;
}

/** Copy `skills/**` verbatim (prose only), skipping any test files. */
function copySkills(src: string, dest: string): void {
  if (!existsSync(src)) return; // a tools-only catalog is valid
  cpSync(src, dest, {
    recursive: true,
    // Never follow a symlink out of the catalog; never copy test artifacts.
    filter: (from) => !isExcluded(from),
    dereference: false,
  });
}

/**
 * Copy `tools/<svc>/` but ONLY `manifest.json` + `wrapper.js` per service —
 * never wrapper.ts, tsconfig*.json, node_modules, the zod symlink, or tests.
 */
function copyTools(src: string, dest: string): void {
  if (!existsSync(src)) return; // skills-only catalog is valid
  for (const dirent of readdirSync(src, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue; // skips tsconfig.wrapper.json (a file)
    const svcSrc = join(src, dirent.name);
    const manifest = join(svcSrc, "manifest.json");
    const wrapperJs = join(svcSrc, "wrapper.js");
    // A service only ships if it has BOTH a manifest and a compiled wrapper.
    if (!existsSync(manifest) || !existsSync(wrapperJs)) continue;

    const svcDest = join(dest, dirent.name);
    mkdirSync(svcDest, { recursive: true });
    cpSync(manifest, join(svcDest, "manifest.json"));
    cpSync(wrapperJs, join(svcDest, "wrapper.js"));
  }
}

/** True for paths that must never be bundled (node_modules, symlinks, TS, tests). */
function isExcluded(path: string): boolean {
  if (path.includes(`${"/"}node_modules${"/"}`) || path.endsWith("/node_modules")) return true;
  if (path.endsWith(".test.ts") || path.endsWith(".test.js")) return true;
  if (path.includes("/__tests__")) return true;
  // Defensive: never traverse a symlink out of the catalog (the dev zod symlink).
  try {
    if (lstatSync(path).isSymbolicLink()) return true;
  } catch {
    /* path may not exist yet during a recursive walk — let cpSync handle it */
  }
  return false;
}

// Run as a script (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dest = bundleCatalog();
  // eslint-disable-next-line no-console -- build-script progress to stderr.
  console.error(`[bundle-catalog] bundled catalog → ${dest}`);
}
