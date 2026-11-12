import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import {
  renderSkillIndex,
  type SkillContent,
  type SkillMeta,
  type SkillProvider,
} from "../../src/skills/index.js";
import { createSkillTools } from "../../src/tools/skills.js";

function provider(content?: Record<string, SkillContent>): SkillProvider & {
  loads: string[];
} {
  const skills = content ?? {
    "builtin:code-review": {
      meta: {
        name: "builtin:code-review",
        description: "Review a diff",
        scope: "builtin",
        version: "v1",
      },
      body: "Review the diff carefully.",
      basePath: "skills/code-review",
      resources: ["checklist.md", "scripts/run.sh"],
    },
  };
  const loads: string[] = [];
  return {
    loads,
    list: () => Object.values(skills).map((skill) => skill.meta),
    load: (name) => {
      loads.push(name);
      return skills[name];
    },
  };
}

describe("load_skill", () => {
  it("loads a body, resources, and trace metadata", async () => {
    const p = provider();
    const [tool] = createSkillTools({ provider: p });
    const result = await tool!.run(
      { name: "builtin:code-review" },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("# Skill: builtin:code-review (builtin)");
    expect(result.content).toContain("Review the diff carefully.");
    expect(result.content).toContain("Files: skills/code-review");
    expect(result.content).toContain("checklist.md");
    expect(result.meta).toMatchObject({
      name: "builtin:code-review",
      scope: "builtin",
      version: "v1",
      truncated: false,
    });
    expect(p.loads).toEqual(["builtin:code-review"]);
  });

  it("lists available skills when the name is unknown", async () => {
    const [tool] = createSkillTools({ provider: provider() });
    const result = await tool!.run({ name: "missing" }, {});
    expect(result.ok).toBe(false);
    expect(result.content).toContain('No skill named "missing"');
    expect(result.content).toContain("builtin:code-review");
  });

  it("truncates an oversized body with the original size", async () => {
    const body = "x".repeat(40);
    const [tool] = createSkillTools({
      provider: provider({
        large: {
          meta: { name: "large", description: "large skill" },
          body,
        },
      }),
      maxBodyChars: 10,
    });
    const result = await tool!.run({ name: "large" }, {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain("xxxxxxxxxx\n\n[truncated: 10 of 40 characters");
    expect(result.content).toContain("40 bytes total");
    expect(result.meta).toMatchObject({ truncated: true, bytes: 40, bodyChars: 40 });
  });

  it("saves an oversized body whole in the sandbox and says where, like any long tool result", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anchor-skill-spill-"));
    const sandbox = new LocalSandbox({}, { rootDir, quiet: true });
    await sandbox.start();
    try {
      const body = `${"head ".repeat(20)}MIDDLE-ONLY${" tail".repeat(20)}`;
      const [tool] = createSkillTools({
        provider: provider({ large: { meta: { name: "large", description: "large skill" }, body, basePath: "/opt/skills/large" } }),
        maxBodyChars: 60,
      });
      const result = await tool!.run({ name: "large" }, { sandbox });
      expect(result.ok).toBe(true);
      expect(result.content).not.toContain("MIDDLE-ONLY");
      const file = /full output saved: (\S+)/.exec(result.content)?.[1];
      expect(file?.startsWith(sandbox.scratch)).toBe(true);
      expect(file).toContain("skill-large");
      expect((await sandbox.exec(`cat ${file}`)).output).toBe(body);
      // The skill's own folder still closes the result: it is where resources live, not the rest of the body.
      expect(result.content.trimEnd().endsWith("Files: /opt/skills/large")).toBe(true);
      expect(result.meta).toMatchObject({ truncated: true, bodyChars: body.length });
    } finally {
      await sandbox.destroy();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("is read-only and returns no tools without a provider", () => {
    const [tool] = createSkillTools({ provider: provider() });
    expect(tool!.readOnly).toBe(true);
    expect(createSkillTools()).toEqual([]);
  });
});

describe("renderSkillIndex", () => {
  const metas: SkillMeta[] = [
    { name: "z", description: "last", scope: "repo" },
    { name: "a", description: "first", scope: "builtin" },
    { name: "b", description: "middle" },
  ];

  it("sorts deterministically and formats one line per skill", () => {
    expect(renderSkillIndex(metas)).toBe(
      ["- a — first (builtin)", "- b — middle", "- z — last (repo)"].join("\n"),
    );
  });

  it("truncates descriptions and the list", () => {
    const text = renderSkillIndex(
      [
        { name: "a", description: "abcdefgh" },
        { name: "b", description: "second" },
        { name: "c", description: "third" },
      ],
      { maxSkills: 1, maxDescription: 5 },
    );
    expect(text).toBe("- a — abcd…\n… 2 more");
  });

  it("returns an empty string for no skills", () => {
    expect(renderSkillIndex([])).toBe("");
  });
});
