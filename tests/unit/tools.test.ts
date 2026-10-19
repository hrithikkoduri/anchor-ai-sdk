/**
 * Tool conformance tests — every tool against a real LocalSandbox.
 * These are the guarantees the agent loop will lean on: faithful exit codes,
 * real kill deadlines, exact-match editing with ambiguity refusal, capped
 * search output, and structured test/finish results.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import { allTools, toolByName, truncate } from "../../src/tools/index.js";
import { runTestsTool } from "../../src/tools/run-tests.js";
import { createFinishTool } from "../../src/tools/finish.js";
import { finishTool } from "../../src/tools/finish.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("tools", () => {
  let rootDir: string;
  let sandbox: LocalSandbox;
  let ctx: ToolContext;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "anchor-tools-"));
    sandbox = new LocalSandbox({}, { rootDir, quiet: true });
    await sandbox.start();
    ctx = { sandbox };
  });

  afterEach(async () => {
    await sandbox.destroy();
    await rm(rootDir, { recursive: true, force: true });
  });

  const file = (...p: string[]) => path.join(sandbox.workspace, ...p);
  const tool = (name: string) => {
    const t = toolByName(name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };

  describe("registry", () => {
    it("exposes the five capability tools with JSON-schema definitions (finish is an engine intrinsic)", () => {
      expect(allTools.map((t) => t.definition.name).sort()).toEqual([
        "bash",
        "edit_file",
        "read_file",
        "run_tests",
        "search",
      ]);
      for (const t of allTools) {
        expect(t.definition.parameters.type).toBe("object");
        expect(t.definition.description.length).toBeGreaterThan(10);
      }
    });
  });

  describe("truncate", () => {
    it("passes short output through unchanged", () => {
      expect(truncate("hello\nworld")).toBe("hello\nworld");
    });

    it("keeps head + tail with an omitted-lines marker", () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line-${i + 1}`);
      const out = truncate(lines.join("\n"));
      expect(out).toContain("[... 200 lines omitted ...]");
      expect(out).toContain("line-1\n");
      expect(out).toContain("line-500");
      expect(out).not.toContain("line-250");
      expect(out.split("\n").length).toBe(301); // 180 head + marker + 120 tail
    });
  });

  describe("bash", () => {
    it("runs a command and reports ok with output", async () => {
      const r = await tool("bash").run({ command: "echo from-bash" }, ctx);
      expect(r.ok).toBe(true);
      expect(r.content).toContain("exit code 0");
      expect(r.content).toContain("from-bash");
    });

    it("reports non-zero exit codes as not ok", async () => {
      const r = await tool("bash").run({ command: "exit 3" }, ctx);
      expect(r.ok).toBe(false);
      expect(r.meta?.exitCode).toBe(3);
    });

    it("kills a hung command at its deadline", async () => {
      const t0 = Date.now();
      const r = await tool("bash").run(
        { command: "sleep 30", timeout_secs: 1 },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.meta?.timedOut).toBe(true);
      expect(Date.now() - t0).toBeLessThan(8_000);
    }, 15_000);
  });

  describe("read_file", () => {
    it("returns numbered lines for the requested range", async () => {
      await writeFile(
        file("five.txt"),
        "line-one\nline-two\nline-three\nline-four\nline-five\n",
      );
      const all = await tool("read_file").run({ path: "five.txt" }, ctx);
      expect(all.ok).toBe(true);
      expect(all.content).toContain("line-one");
      expect(all.content).toContain("line-five");

      const middle = await tool("read_file").run(
        { path: "five.txt", offset: 2, limit: 2 },
        ctx,
      );
      expect(middle.content).toContain("line-two");
      expect(middle.content).toContain("line-three");
      expect(middle.content).not.toContain("line-four");
      expect(middle.content).toContain("-- lines 2-3 of 5 --");
    });

    it("fails cleanly for a missing file", async () => {
      const r = await tool("read_file").run({ path: "nope.txt" }, ctx);
      expect(r.ok).toBe(false);
      expect(r.content).toContain("cannot read nope.txt");
    });
  });

  describe("edit_file", () => {
    it("replaces a unique match and reports the line", async () => {
      await writeFile(
        file("app.js"),
        "const a = 1;\nconst b = 2;\nconst c = 3;\n",
      );
      const r = await tool("edit_file").run(
        {
          path: "app.js",
          old_string: "const b = 2;",
          new_string: "const b = 42;",
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.meta?.line).toBe(2);
      const after = await readFile(file("app.js"), "utf8");
      expect(after).toBe("const a = 1;\nconst b = 42;\nconst c = 3;\n");
    });

    it("refuses when the old string is not present", async () => {
      await writeFile(file("x.js"), "hello\n");
      const r = await tool("edit_file").run(
        { path: "x.js", old_string: "goodbye", new_string: "hi" },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.content).toContain("not found");
    });

    it("refuses ambiguous matches and counts them", async () => {
      await writeFile(file("dup.js"), "same();\nother();\nsame();\n");
      const r = await tool("edit_file").run(
        { path: "dup.js", old_string: "same();", new_string: "next();" },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.content).toContain("appears 2 times");
      expect(await readFile(file("dup.js"), "utf8")).toBe(
        "same();\nother();\nsame();\n",
      );
    });

    it("handles multi-line replacements and empty new_string deletions", async () => {
      await writeFile(file("multi.js"), "start\nremove me\nand me\nafter\n");
      const del = await tool("edit_file").run(
        { path: "multi.js", old_string: "remove me\nand me\n", new_string: "" },
        ctx,
      );
      expect(del.ok).toBe(true);
      expect(await readFile(file("multi.js"), "utf8")).toBe("start\nafter\n");
    });

    it("preserves a missing trailing newline exactly", async () => {
      await writeFile(file("nonl.js"), "no trailing newline at all");
      const r = await tool("edit_file").run(
        { path: "nonl.js", old_string: "at all", new_string: "here" },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(await readFile(file("nonl.js"), "utf8")).toBe(
        "no trailing newline here",
      );
    });
  });

  describe("search", () => {
    beforeEach(async () => {
      await mkdir(file("src"), { recursive: true });
      await writeFile(
        file("src/a.txt"),
        "call foo(1) now\nnothing here\na+b.c special\n",
      );
      await writeFile(file("src/b.txt"), "foo1 and foo22\n");
    });

    it("finds fixed strings including special characters", async () => {
      const r = await tool("search").run({ pattern: "foo(1)" }, ctx);
      expect(r.ok).toBe(true);
      expect(r.content).toContain("src/a.txt");
    });

    it("reports no matches as an ok result", async () => {
      const r = await tool("search").run({ pattern: "zzz-not-there" }, ctx);
      expect(r.ok).toBe(true);
      expect(r.content).toContain("no matches");
    });

    it("supports regex mode", async () => {
      const r = await tool("search").run(
        { pattern: "foo[0-9]+", regex: true },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.content).toContain("foo22");
      const fixed = await tool("search").run(
        { pattern: "foo[0-9]+", regex: false },
        ctx,
      );
      expect(fixed.content).toContain("no matches");
    });

    it("caps results and says so", async () => {
      const many = Array.from({ length: 8 }, (_, i) => `needle line ${i}`).join(
        "\n",
      );
      await writeFile(file("src/many.txt"), `${many}\n`);
      const r = await tool("search").run(
        { pattern: "needle", max_results: 3 },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.content).toContain("3+ match(es)");
      expect(r.content).toContain("refine the pattern");
      expect(r.meta?.truncated).toBe(true);
    });
  });

  describe("run_tests", () => {
    it("runs an explicit command and reports ok", async () => {
      const r = await tool("run_tests").run(
        { command: "echo TESTS-PASS" },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.content).toContain("run_tests: echo TESTS-PASS");
      expect(r.content).toContain("TESTS-PASS");
      // freshness evidence: the working-tree content hash (decision #38)
      expect(String(r.meta?.treeHash)).toMatch(/^[0-9a-f]{40}$/);
    });

    it("uses the configured default command when the model passes none", async () => {
      const r = await runTestsTool({ defaultCommand: "echo FROM-CTX" }).run(
        {},
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.content).toContain("FROM-CTX");
      expect(r.meta?.defaultCommand).toBe(true);
    });

    it("propagates failing exit codes", async () => {
      const r = await tool("run_tests").run({ command: "exit 5" }, ctx);
      expect(r.ok).toBe(false);
      expect(r.meta?.exitCode).toBe(5);
    });

    it("auto-detects npm test from package.json", async () => {
      await writeFile(
        file("package.json"),
        JSON.stringify({
          name: "x",
          version: "1.0.0",
          scripts: { test: "echo detected-ok" },
        }),
      );
      const r = await tool("run_tests").run({}, ctx);
      expect(r.ok).toBe(true);
      expect(String(r.meta?.command)).toContain("test");
      expect(r.content).toContain("detected-ok");
    }, 15_000);
  });

  describe("finish (engine intrinsic, imported directly)", () => {
    it("records the summary through the context callback", async () => {
      let captured = "";
      const r = await finishTool.run(
        { summary: "fixed the parser bug", success: true },
        { ...ctx, onFinish: (s) => (captured = s) },
      );
      expect(r.ok).toBe(true);
      expect(captured).toBe("fixed the parser bug");
      expect(r.content).toContain("run will stop");
      expect(r.meta?.success).toBe(true);
    });

    it("carries a consumer-shaped handoff through meta, untouched", async () => {
      const consumer = createFinishTool({
        handoff: {
          schema: {
            type: "object",
            properties: { intent: { type: "string" } },
          },
          description: "Test handoff.",
        },
      });
      const handoff = { intent: "watch", resumeAt: "fix" };
      const r = await consumer.run(
        { summary: "x", success: true, handoff },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.meta?.handoff).toEqual(handoff);
      // The parameter is declared from the schema (the model sees it).
      expect(consumer.definition.parameters).toMatchObject({
        properties: { handoff: { type: "object" } },
      });
    });

    it("rejects a handoff when no schema is configured", async () => {
      const bad = await finishTool.run(
        { summary: "x", handoff: { intent: "watch" } },
        ctx,
      );
      expect(bad.ok).toBe(false);
      expect(bad.content).toContain("handoff");
    });
  });
});
