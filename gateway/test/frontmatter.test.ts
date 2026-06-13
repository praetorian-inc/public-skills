import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "../src/catalog/frontmatter.js";

const here = dirname(fileURLToPath(import.meta.url));
const yagniSkill = join(here, "fixtures/.agentsmesh/skills/adhering-to-yagni/SKILL.md");

describe("parseFrontmatter", () => {
  it("extracts name and description from a fixture SKILL.md", () => {
    const md = readFileSync(yagniSkill, "utf8");
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe("adhering-to-yagni");
    expect(fm.description).toContain("You Aren't Gonna Need It");
  });

  it("tolerates a missing trailing newline at end of file", () => {
    const md = "---\nname: foo\ndescription: bar\n---\n# Body".replace(/\n$/, "");
    const fm = parseFrontmatter(md);
    expect(fm).toEqual({ name: "foo", description: "bar" });
  });

  it("tolerates no body after the frontmatter block", () => {
    const md = "---\nname: foo\ndescription: bar\n---";
    const fm = parseFrontmatter(md);
    expect(fm).toEqual({ name: "foo", description: "bar" });
  });

  it("errors clearly when there is no frontmatter block", () => {
    expect(() => parseFrontmatter("# Just a heading\n\nsome text")).toThrow(/frontmatter/i);
  });

  it("errors clearly when name is absent", () => {
    expect(() => parseFrontmatter("---\ndescription: bar\n---\n")).toThrow(/name/i);
  });

  it("errors clearly when description is absent", () => {
    expect(() => parseFrontmatter("---\nname: foo\n---\n")).toThrow(/description/i);
  });

  it("errors when the frontmatter block is not closed", () => {
    expect(() => parseFrontmatter("---\nname: foo\ndescription: bar\n")).toThrow(/frontmatter/i);
  });
});
