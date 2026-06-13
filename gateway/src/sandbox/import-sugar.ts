/**
 * Import-sugar source transform for `run_code` (WS-C, design §4 / P2 §8, O3=C-2).
 *
 * The `run_code` isolate is a bare V8 isolate with NO module loader (P1 §6.4) —
 * a literal `import` statement is a syntax error there. P1 shipped the frozen
 * global accessor `caps.<service>.<tool>(args)`; this transform lets model code
 * ALSO write the more ergonomic `import { tool } from "caps/<service>"` by
 * rewriting those statements to `const`-destructuring over the SAME frozen global
 * BEFORE compilation. The frozen-global security semantics are therefore
 * byte-unchanged (A0-IMPORT decided C-2 over C-1/`compileModule` for exactly this
 * reason — see plan §14.1).
 *
 * Scope (deliberately narrow, KISS):
 *   - Rewrites ONLY imports whose specifier is exactly `caps/<svc>` where `<svc>`
 *     is a valid JS identifier.
 *   - `import { a, b as c } from "caps/<svc>";`  → `const { a, b: c } = caps.<svc>;`
 *   - `import * as svc from "caps/<svc>";`       → `const svc = caps.<svc>;`
 *   - Every other line is left BYTE-IDENTICAL. A non-`caps/` import is untouched
 *     (it will still fail in-isolate as today → `sandbox_error`); the transform
 *     does not try to handle it because the isolate has no loader.
 *
 * Robustness:
 *   - Imports are anchored to the START of a line (after optional leading
 *     whitespace), so an import-like substring inside a string literal
 *     (`const s = 'import { x } from "caps/svc"'`) or a block comment
 *     (`/* import ... *​/`) is NOT a line-start `import` and is left alone.
 *   - Injection-free codegen: only clean identifier bindings (and `x as y`
 *     aliases) are emitted into the executable `const { ... }` position. Any
 *     binding that is not a plain identifier — or a default import (caps modules
 *     have no default export) — throws (surfacing as `sandbox_error`), so no
 *     attacker-controlled text reaches an executable position.
 */

/** A JS identifier (the only thing allowed in a binding or `<svc>` position). */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Matches a line that is (after optional leading whitespace) a `caps/<svc>`
 * import statement. Capture groups:
 *   1 = leading whitespace (preserved)
 *   2 = the import clause (`{ ... }`, `* as svc`, or a bare default ident)
 *   3 = the service specifier path after `caps/`
 * The trailing `;` is optional. Anything after a valid match on the same line is
 * disallowed by `$` so we never swallow trailing code.
 */
const CAPS_IMPORT_LINE =
  /^(\s*)import\s+(.+?)\s+from\s+["']caps\/([^"']*)["']\s*;?\s*$/;

/** Parse a `{ a, b as c }` import clause into `a, b: c` destructuring fields. */
function parseNamedBindings(clause: string): string {
  // Strip the surrounding braces and split on commas. Each part is either a bare
  // identifier or an `name as alias` pair. Anything else is rejected.
  const inner = clause.slice(1, -1).trim();
  if (inner === "") return "";
  const parts = inner.split(",");
  const fields: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (part === "") continue; // tolerate a trailing comma
    const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(part);
    if (asMatch) {
      const [, name, alias] = asMatch;
      if (!IDENT.test(name) || !IDENT.test(alias)) {
        throw new Error(`import-sugar: invalid binding "${part}"`);
      }
      fields.push(`${name}: ${alias}`);
    } else {
      if (!IDENT.test(part)) {
        throw new Error(`import-sugar: invalid binding "${part}"`);
      }
      fields.push(part);
    }
  }
  return fields.join(", ");
}

/** Rewrite a single matched caps-import line; throws on a malformed binding. */
function rewriteLine(indent: string, clause: string, svc: string): string {
  if (!IDENT.test(svc)) {
    throw new Error(`import-sugar: invalid caps service "${svc}"`);
  }
  const trimmed = clause.trim();

  // Namespace import: `* as svc`
  const nsMatch = /^\*\s+as\s+(\S+)$/.exec(trimmed);
  if (nsMatch) {
    const alias = nsMatch[1];
    if (!IDENT.test(alias)) {
      throw new Error(`import-sugar: invalid namespace alias "${alias}"`);
    }
    return `${indent}const ${alias} = caps.${svc};`;
  }

  // Named imports: `{ ... }`
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const fields = parseNamedBindings(trimmed);
    return `${indent}const { ${fields} } = caps.${svc};`;
  }

  // Anything else on a caps module (default import, mixed default+named, etc.) is
  // rejected: caps modules expose only named tool accessors, so a default import
  // is a programming error and a clear failure beats silent wrong behaviour.
  throw new Error(
    `import-sugar: only named ("{ a, b as c }") or namespace ("* as svc") ` +
      `imports are supported for caps/<service>; got "${trimmed}"`,
  );
}

/**
 * Rewrite `import ... from "caps/<svc>"` statements to `const`-destructuring over
 * the frozen `caps.<svc>` global. All other source is returned byte-identical.
 *
 * @throws Error on a malformed/dangerous caps-import binding (default import,
 *   non-identifier binding/alias, or invalid service identifier). The caller
 *   maps this to `sandbox_error`.
 */
export function desugarCapsImports(source: string): string {
  const lines = source.split("\n");
  let changed = false;
  const out = lines.map((line) => {
    const m = CAPS_IMPORT_LINE.exec(line);
    if (!m) return line;
    const [, indent, clause, svc] = m;
    changed = true;
    return rewriteLine(indent, clause, svc);
  });
  return changed ? out.join("\n") : source;
}
