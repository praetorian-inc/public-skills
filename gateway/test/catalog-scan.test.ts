import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildIndex } from "../src/catalog/catalog-index.js";
import { GatewayError } from "../src/errors/to-tool-error.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures/.agentsmesh");

/** Build a throwaway catalog root under a tmp dir for collision/tool cases. */
function makeCatalog(): {
  root: string;
  addSkill: (id: string, name: string, description: string) => void;
  addToolManifest: (service: string, manifest: unknown) => void;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "gw-catalog-"));
  return {
    root,
    addSkill(id, name, description) {
      const d = join(root, "skills", id);
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
        "utf8",
      );
    },
    addToolManifest(service, manifest) {
      const d = join(root, "tools", service);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "manifest.json"), JSON.stringify(manifest), "utf8");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("buildIndex — skills-only fixture catalog", () => {
  it("finds the 2 fixture skills with correct ids, kinds, and names", () => {
    const entries = buildIndex(fixtureRoot);
    const skills = entries.filter((e) => e.kind === "skill");
    expect(skills).toHaveLength(2);

    const byId = new Map(skills.map((e) => [e.id, e]));
    expect(byId.has("adhering-to-yagni")).toBe(true);
    expect(byId.has("adhering-to-dry")).toBe(true);

    const yagni = byId.get("adhering-to-yagni")!;
    expect(yagni.kind).toBe("skill");
    expect(yagni.name).toBe("adhering-to-yagni");
    expect(yagni.description).toContain("You Aren't Gonna Need It");
    expect(yagni.path).toContain(join("skills", "adhering-to-yagni"));
  });

  it("tolerates a catalog with no tools/ directory", () => {
    const entries = buildIndex(fixtureRoot);
    expect(entries.every((e) => e.kind === "skill")).toBe(true);
  });
});

describe("buildIndex — tool entries", () => {
  let cat: ReturnType<typeof makeCatalog>;
  afterAll(() => cat?.cleanup());

  it("emits one tool entry per tool, id namespaced as service.tool", () => {
    cat = makeCatalog();
    cat.addSkill("my-skill", "my-skill", "A skill.");
    cat.addToolManifest("echo", {
      manifestVersion: 1,
      service: "echo",
      tools: [
        {
          id: "echo.echo",
          name: "echo",
          description: "Echo text.",
          inputSchema: {},
          outputSchema: {},
          entry: "wrapper.ts#echo",
        },
        {
          id: "echo.shout",
          name: "shout",
          description: "Echo loudly.",
          inputSchema: {},
          outputSchema: {},
          entry: "wrapper.ts#shout",
        },
      ],
    });

    const entries = buildIndex(cat.root);
    const tools = entries.filter((e) => e.kind === "tool");
    expect(tools).toHaveLength(2);
    const ids = tools.map((t) => t.id).sort();
    expect(ids).toEqual(["echo.echo", "echo.shout"]);
    const echo = tools.find((t) => t.id === "echo.echo")!;
    expect(echo.name).toBe("echo");
    expect(echo.description).toBe("Echo text.");
    expect(echo.path).toContain(join("tools", "echo", "manifest.json"));
  });
});

describe("buildIndex — id uniqueness", () => {
  it("throws loudly on a collision across the whole namespace", () => {
    const cat = makeCatalog();
    try {
      // A skill dir named "echo.echo" colliding with a tool id "echo.echo".
      cat.addSkill("echo.echo", "echo.echo", "Colliding skill.");
      cat.addToolManifest("echo", {
        manifestVersion: 1,
        service: "echo",
        tools: [
          {
            id: "echo.echo",
            name: "echo",
            description: "Echo text.",
            inputSchema: {},
            outputSchema: {},
            entry: "wrapper.ts#echo",
          },
        ],
      });
      expect(() => buildIndex(cat.root)).toThrow(/collision|duplicate|unique/i);
    } finally {
      cat.cleanup();
    }
  });

  it("throws on duplicate tool ids across two manifests", () => {
    const cat = makeCatalog();
    try {
      cat.addToolManifest("svc-a", {
        manifestVersion: 1,
        service: "svc-a",
        tools: [
          {
            id: "shared.tool",
            name: "tool",
            description: "A.",
            inputSchema: {},
            outputSchema: {},
            entry: "wrapper.ts#tool",
          },
        ],
      });
      cat.addToolManifest("svc-b", {
        manifestVersion: 1,
        service: "svc-b",
        tools: [
          {
            id: "shared.tool",
            name: "tool",
            description: "B.",
            inputSchema: {},
            outputSchema: {},
            entry: "wrapper.ts#tool",
          },
        ],
      });
      expect(() => buildIndex(cat.root)).toThrow(GatewayError);
    } finally {
      cat.cleanup();
    }
  });
});
