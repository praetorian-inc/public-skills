/**
 * Group C1 (WS-C) — unit tests for the pure import-sugar source transform.
 *
 * `desugarCapsImports(source)` rewrites `import ... from "caps/<svc>"` statements
 * into `const`-destructuring over the existing frozen `caps.<svc>` global, BEFORE
 * the source is compiled in the isolate (the bare V8 isolate has no module
 * loader, so a literal `import` would otherwise be a syntax error). It is a pure,
 * offline-testable function with no isolate dependency.
 *
 * Rewrite rules proven here:
 *   - named import           import { a } from "caps/svc";          → const { a } = caps.svc;
 *   - aliased named import    import { a as b } from "caps/svc";     → const { a: b } = caps.svc;
 *   - namespace import        import * as svc from "caps/svc";       → const svc = caps.svc;
 *   - non-caps specifiers are left UNTOUCHED (fail in-isolate as today)
 *   - default import on a caps module is REJECTED (caps modules have no default export)
 *   - malformed / non-identifier bindings are REJECTED (injection-free codegen)
 *   - an import-like STRING or comment is NOT rewritten
 *   - source with no caps imports is returned byte-identical
 */
import { describe, it, expect } from "vitest";
import { desugarCapsImports } from "../src/sandbox/import-sugar.js";

describe("desugarCapsImports — named imports", () => {
  it("rewrites a single named import into const-destructuring over caps.<svc>", () => {
    const out = desugarCapsImports(`import { run_soql } from "caps/salesforce";`);
    expect(out).toBe(`const { run_soql } = caps.salesforce;`);
  });

  it("rewrites multiple named imports", () => {
    const out = desugarCapsImports(`import { a, b, c } from "caps/svc";`);
    expect(out).toBe(`const { a, b, c } = caps.svc;`);
  });

  it("rewrites an aliased named import using object-rename syntax", () => {
    const out = desugarCapsImports(`import { a, b as c } from "caps/svc";`);
    expect(out).toBe(`const { a, b: c } = caps.svc;`);
  });

  it("rewrites a named import written with single quotes", () => {
    const out = desugarCapsImports(`import { x } from 'caps/svc';`);
    expect(out).toBe(`const { x } = caps.svc;`);
  });

  it("rewrites without a trailing semicolon on the import", () => {
    const out = desugarCapsImports(`import { x } from "caps/svc"`);
    expect(out).toBe(`const { x } = caps.svc;`);
  });
});

describe("desugarCapsImports — namespace imports", () => {
  it("rewrites import * as svc into const svc = caps.<svc>", () => {
    const out = desugarCapsImports(`import * as sf from "caps/salesforce";`);
    expect(out).toBe(`const sf = caps.salesforce;`);
  });
});

describe("desugarCapsImports — non-caps imports are left untouched", () => {
  it("leaves a non-caps specifier byte-identical", () => {
    const src = `import { z } from "zod";`;
    expect(desugarCapsImports(src)).toBe(src);
  });

  it("leaves a relative import byte-identical", () => {
    const src = `import foo from "./foo.js";`;
    expect(desugarCapsImports(src)).toBe(src);
  });

  it("leaves a 'caps' bare specifier (not caps/<svc>) untouched", () => {
    const src = `import { x } from "caps";`;
    expect(desugarCapsImports(src)).toBe(src);
  });
});

describe("desugarCapsImports — rejects dangerous / malformed bindings", () => {
  it("rejects a default import on a caps module (no default export)", () => {
    expect(() => desugarCapsImports(`import sf from "caps/salesforce";`)).toThrow();
  });

  it("rejects a non-identifier binding name (injection attempt)", () => {
    // A malicious binding that tries to smuggle executable code into the
    // const-destructuring position must NOT be emitted.
    expect(() =>
      desugarCapsImports(`import { x = sideEffect() } from "caps/svc";`),
    ).toThrow();
  });

  it("rejects an invalid service identifier in the specifier", () => {
    expect(() => desugarCapsImports(`import { x } from "caps/not-an-ident";`)).toThrow();
  });
});

describe("desugarCapsImports — import-like strings/comments are NOT rewritten", () => {
  it("does not rewrite an import statement inside a string literal", () => {
    const src = `const s = 'import { x } from "caps/svc";';`;
    expect(desugarCapsImports(src)).toBe(src);
  });

  it("does not rewrite an import-like line inside a block comment", () => {
    const src = `/* import { x } from "caps/svc"; */ const y = 1;`;
    expect(desugarCapsImports(src)).toBe(src);
  });
});

describe("desugarCapsImports — non-import source is byte-identical", () => {
  it("returns ordinary code unchanged", () => {
    const src = `const a = caps.echo.echo({ text: "hi" });\nreturn a.text;`;
    expect(desugarCapsImports(src)).toBe(src);
  });

  it("rewrites only the caps imports and leaves the rest intact", () => {
    const src = [
      `import { run_soql } from "caps/salesforce";`,
      `import { z } from "zod";`,
      `const r = run_soql({ q: "SELECT Id FROM Account" });`,
    ].join("\n");
    const expected = [
      `const { run_soql } = caps.salesforce;`,
      `import { z } from "zod";`,
      `const r = run_soql({ q: "SELECT Id FROM Account" });`,
    ].join("\n");
    expect(desugarCapsImports(src)).toBe(expected);
  });
});
