/**
 * The batch tool against a real LocalSandbox: order, concurrency, edit
 * atomicity, caps with a full log, the per-op cache, and per-op refusals.
 * Each test fails if the behaviour it names is reverted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import {
  bashTool,
  createBatchTool,
  editFileTool,
  readFileTool,
  searchTool,
  type Tool,
  type ToolContext,
} from "../../src/tools/index.js";
import { allotment, renderBatch, type OpReport } from "../../src/tools/batch/render.js";
import { applyEdits, lineDelta } from "../../src/tools/batch/edits.js";
import { parseBatch } from "../../src/tools/batch/ops.js";
import { isReadOnlyCommand } from "../../src/tools/batch/commands.js";

let rootDir: string;
let sandbox: LocalSandbox;
let ctx: ToolContext;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "anchor-batch-"));
  sandbox = new LocalSandbox({}, { rootDir, quiet: true });
  await sandbox.start();
  ctx = { sandbox };
});

afterEach(async () => {
  await sandbox.destroy();
  await rm(rootDir, { recursive: true, force: true });
});

const file = (name: string) => path.join(sandbox.workspace, name);

/** A tool that records how many of its kind run at once, then delegates. */
function tracked(tool: Tool, log: { active: number; max: number; order: string[] }): Tool {
  return {
    ...tool,
    run: async (input, c) => {
      log.active += 1;
      log.max = Math.max(log.max, log.active);
      log.order.push(`start:${tool.definition.name}:${String(input.path ?? input.command)}`);
      await new Promise((r) => setTimeout(r, 150));
      try {
        return await tool.run(input, c);
      } finally {
        log.active -= 1;
        log.order.push(`end:${tool.definition.name}:${String(input.path ?? input.command)}`);
      }
    },
  };
}

describe("batch: shape and order", () => {
  it("runs phases in order: write, then edit, then the command sees both", async () => {
    const batch = createBatchTool();
    const r = await batch.run(
      {
        phases: [
          { ops: [{ op: "write", path: "src/a.ts", content: "export const a = 1;\n" }] },
          { ops: [{ op: "edit", path: "src/a.ts", old: "= 1", new: "= 2" }] },
          { ops: [{ op: "bash", command: "cat src/a.ts" }, { op: "read", path: "src/a.ts" }] },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const labels = r.content.split("\n").filter((line) => line.startsWith("#"));
    expect(labels.map((line) => line.split(" ")[0])).toEqual(["#1", "#2", "#3", "#4"]);
    expect(labels[1]).toBe("#2 edit src/a.ts — ok (1 replacement, +1/−1)");
    expect(labels[2]).toContain("#3 bash `cat src/a.ts` — ok (exit 0)");
    expect(r.content).toContain("export const a = 2;");
  });

  it("a flat ops list is one phase", () => {
    const parsed = parseBatch({ ops: [{ op: "read", paths: ["a", "b"] }, { op: "search", pattern: "x" }] });
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.phases).toHaveLength(1);
    expect(parsed.phases[0]!.concurrent).toBe(true);
    expect(parsed.units).toBe(3);
    expect(parsed.ops).toBe(2);
  });

  it("bounds the batch at 20 ops, counting each read path", async () => {
    const r = await createBatchTool().run(
      { ops: [{ op: "read", paths: Array.from({ length: 21 }, (_, i) => `f${i}`) }] },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("at most 20 ops");
  });

  it("reports a malformed op on its own while the rest run", async () => {
    await writeFile(file("a.txt"), "hello\n");
    const r = await createBatchTool().run({ ops: [{ op: "edit", path: "a.txt" }, { op: "read", path: "a.txt" }] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("#1 edit a.txt — failed (invalid op)");
    expect(r.content).toContain("#2 read a.txt — ok");
    expect(r.content).toContain("hello");
  });
});

describe("batch: concurrency", () => {
  it("reads in one phase run concurrently", async () => {
    for (const name of ["a", "b", "c"]) await writeFile(file(`${name}.txt`), `${name}\n`);
    const log = { active: 0, max: 0, order: [] as string[] };
    const batch = createBatchTool({ tools: [tracked(readFileTool, log), searchTool, bashTool, editFileTool], cache: false });
    const r = await batch.run({ ops: [{ op: "read", paths: ["a.txt", "b.txt", "c.txt"] }] }, ctx);
    expect(r.ok).toBe(true);
    expect(log.max).toBe(3);
  });

  it("a command in a phase makes the whole phase sequential, in op order", async () => {
    for (const name of ["a", "b"]) await writeFile(file(`${name}.txt`), `${name}\n`);
    const log = { active: 0, max: 0, order: [] as string[] };
    const batch = createBatchTool({
      tools: [tracked(readFileTool, log), searchTool, tracked(bashTool, log), editFileTool],
      cache: false,
    });
    const r = await batch.run(
      { ops: [{ op: "read", path: "a.txt" }, { op: "bash", command: "echo hi" }, { op: "read", path: "b.txt" }] },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(log.max).toBe(1);
    expect(log.order).toEqual([
      "start:read_file:a.txt",
      "end:read_file:a.txt",
      "start:bash:echo hi",
      "end:bash:echo hi",
      "start:read_file:b.txt",
      "end:read_file:b.txt",
    ]);
  });

  it("writes serialize: edits and commands never overlap", async () => {
    await writeFile(file("a.txt"), "one\n");
    await writeFile(file("b.txt"), "two\n");
    const log = { active: 0, max: 0, order: [] as string[] };
    const batch = createBatchTool({
      tools: [readFileTool, searchTool, tracked(bashTool, log), tracked(editFileTool, log)],
    });
    const r = await batch.run(
      {
        ops: [
          { op: "edit", path: "a.txt", old: "one", new: "uno" },
          { op: "edit", path: "b.txt", old: "two", new: "dos" },
          { op: "bash", command: "cat a.txt b.txt" },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(log.max).toBe(1);
    expect(r.content).toContain("uno\ndos");
  });
});

describe("batch: edits are all-or-nothing per file", () => {
  it("one bad old leaves the file intact and names the failed edit", async () => {
    const original = "alpha\nbeta\ngamma\n";
    await writeFile(file("x.ts"), original);
    const r = await createBatchTool().run(
      {
        ops: [
          { op: "edit", path: "x.ts", old: "alpha", new: "ALPHA" },
          { op: "edit", path: "x.ts", old: "delta", new: "DELTA" },
          { op: "edit", path: "x.ts", old: "gamma", new: "GAMMA" },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(await readFile(file("x.ts"), "utf8")).toBe(original);
    expect(r.content).toContain("#2 edit x.ts — failed");
    expect(r.content).toContain('edit #2: "old" not found');
    expect(r.content).toContain("not applied — edit #2 on this file failed");
  });

  it("several edits on one file are one write through edit_file", async () => {
    await writeFile(file("x.ts"), "a\nb\nc\nb2\n");
    let writes = 0;
    const counting: Tool = { ...editFileTool, run: async (i, c) => ((writes += 1), editFileTool.run(i, c)) };
    const r = await createBatchTool({ tools: [readFileTool, searchTool, bashTool, counting] }).run(
      {
        ops: [
          { op: "edit", path: "x.ts", old: "a\n", new: "a\nadded1\nadded2\n" },
          { op: "edit", path: "x.ts", old: "b", new: "B", replaceAll: true },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(writes).toBe(1);
    expect(await readFile(file("x.ts"), "utf8")).toBe("a\nadded1\nadded2\nB\nc\nB2\n");
    expect(r.content).toContain("#1 edit x.ts — ok (1 replacement, +2/−0)");
    expect(r.content).toContain("#2 edit x.ts — ok (2 replacements, +2/−2)");
  });

  it("an ambiguous old without replaceAll fails", () => {
    const out = applyEdits("x x", [{ index: 4, old: "x", new: "y", replaceAll: false }]);
    expect(out).toEqual({ ok: false, failed: 4, reason: expect.stringContaining("appears 2 times") });
  });

  it("lineDelta ignores the shared context around a change", () => {
    expect(lineDelta("a\nb\nc", "a\nB\nB2\nc")).toEqual({ added: 2, removed: 1 });
    expect(lineDelta("same", "same")).toEqual({ added: 0, removed: 0 });
  });
});

describe("batch: caps and the full log", () => {
  it("caps one op's output, names the log, and the log holds everything", async () => {
    const r = await createBatchTool({ logDir: path.join(rootDir, "batch-logs") }).run(
      { ops: [{ op: "bash", command: "seq 1 1000" }, { op: "bash", command: "echo small" }] },
      ctx,
    );
    expect(r.ok).toBe(true);
    const log = (r.meta as { log: string }).log;
    expect(log.startsWith(path.join(rootDir, "batch-logs"))).toBe(true);
    expect(r.content.split("\n")[0]).toContain(`Full log: ${log}`);
    const first = r.content.split("\n\n#2")[0]!;
    expect(first.split("\n").length).toBeLessThanOrEqual(310);
    expect(r.content).toContain(`[#1: output clipped here — full output in ${log}]`);
    expect(r.content).toContain("small");
    const saved = await readFile(log, "utf8");
    expect(saved).toContain("#1 bash `seq 1 1000` — ok (exit 0)");
    expect(saved).toContain("small");
  });

  it("caps the batch total, and every clipped op says so", () => {
    const body = Array.from({ length: 290 }, (_, i) => `line ${i}`).join("\n");
    const reports: OpReport[] = [1, 2, 3].map((index) => ({ index, op: "bash", target: "x", status: "ok", body }));
    const out = renderBatch(reports, "header", "full output in /tmp/l.log");
    const bodyLines = out.content.split("\n").filter((line) => line.startsWith("line ")).length;
    expect(bodyLines).toBeLessThanOrEqual(600);
    for (const index of [1, 2, 3]) expect(out.content).toContain(`[#${index}: output clipped here — full output in /tmp/l.log]`);
    expect(out.clipped).toBe(true);
  });

  it("short outputs keep every line; long ones share the rest", () => {
    expect(allotment([10, 20], 600)).toBe(20);
    expect(allotment([10, 500, 500], 600)).toBe(295);
  });
});

describe("batch: cache", () => {
  it("a read hits across batches; a modified file (same size) misses", async () => {
    await writeFile(file("a.ts"), "const v = 1;\n");
    const batch = createBatchTool();
    const first = await batch.run({ ops: [{ op: "read", path: "a.ts" }] }, ctx);
    expect(first.content).toContain("#1 read a.ts — ok\n");
    const second = await batch.run({ ops: [{ op: "read", path: "a.ts" }] }, ctx);
    expect(second.content).toContain("#1 read a.ts — ok (cached)");
    const body = (text: string) => text.split("\n").slice(3).join("\n").replace(/\n\(cached\)$/, "");
    expect(body(second.content)).toBe(body(first.content));
    await writeFile(file("a.ts"), "const v = 2;\n");
    const third = await batch.run({ ops: [{ op: "read", path: "a.ts" }] }, ctx);
    expect(third.content).toContain("#1 read a.ts — ok\n");
    expect(third.content).toContain("const v = 2;");
  });

  it("a different window of the same file is its own entry", async () => {
    await writeFile(file("a.ts"), "1\n2\n3\n");
    const batch = createBatchTool();
    await batch.run({ ops: [{ op: "read", path: "a.ts" }] }, ctx);
    const paged = await batch.run({ ops: [{ op: "read", path: "a.ts", offset: 2, limit: 1 }] }, ctx);
    expect(paged.content).not.toContain("(cached)");
  });

  it("a search hits until a file in its scope changes", async () => {
    await writeFile(file("a.ts"), "needle\n");
    const batch = createBatchTool();
    const op = { ops: [{ op: "search", pattern: "needle", path: "." }] };
    await batch.run(op, ctx);
    expect((await batch.run(op, ctx)).content).toContain("(cached)");
    await appendFile(file("b.ts"), "needle again\n");
    const after = await batch.run(op, ctx);
    expect(after.content).not.toContain("(cached)");
    expect(after.content).toContain("b.ts");
  });

  it("edits, writes and commands are never cached", async () => {
    await writeFile(file("a.txt"), "x\n");
    const batch = createBatchTool();
    const flip = { ops: [{ op: "edit", path: "a.txt", old: "x", new: "y" }, { op: "bash", command: "cat a.txt" }] };
    const back = { ops: [{ op: "edit", path: "a.txt", old: "y", new: "x" }, { op: "bash", command: "cat a.txt" }] };
    expect((await batch.run(flip, ctx)).content).toContain("\ny");
    expect((await batch.run(back, ctx)).content).toContain("\nx");
    const again = await batch.run(flip, ctx);
    expect(again.content).not.toContain("(cached)");
    expect(await readFile(file("a.txt"), "utf8")).toBe("y\n");
  });

  it("cache: false never answers from the cache", async () => {
    await writeFile(file("a.ts"), "v\n");
    const batch = createBatchTool({ cache: false });
    await batch.run({ ops: [{ op: "read", path: "a.ts" }] }, ctx);
    expect((await batch.run({ ops: [{ op: "read", path: "a.ts" }] }, ctx)).content).not.toContain("(cached)");
  });
});

describe("batch: guards per op", () => {
  it("an agent without edit_file is refused edit and write per op; its reads still run", async () => {
    await writeFile(file("a.ts"), "keep\n");
    const batch = createBatchTool({ tools: [readFileTool, searchTool, bashTool] });
    const r = await batch.run(
      {
        ops: [
          { op: "read", path: "a.ts" },
          { op: "edit", path: "a.ts", old: "keep", new: "lose" },
          { op: "write", path: "b.ts", content: "new\n" },
          { op: "search", pattern: "keep" },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("#1 read a.ts — ok");
    expect(r.content).toContain("#2 edit a.ts — refused");
    expect(r.content).toContain("#3 write b.ts — refused");
    expect(r.content).toContain('#4 search "keep" — ok (1 match)');
    expect(await readFile(file("a.ts"), "utf8")).toBe("keep\n");
    await expect(readFile(file("b.ts"), "utf8")).rejects.toThrow();
  });

  it("each bash op passes through the agent's own bash guard", async () => {
    const guarded: Tool = {
      ...bashTool,
      run: async (input, c) =>
        String(input.command).includes("rm ")
          ? { ok: false, content: "refused by the guard", meta: { refused: true } }
          : bashTool.run(input, c),
    };
    const r = await createBatchTool({ tools: [readFileTool, guarded] }).run(
      { ops: [{ op: "bash", command: "rm -rf x" }, { op: "bash", command: "echo after" }] },
      ctx,
    );
    expect(r.content).toContain("#1 bash `rm -rf x` — refused");
    expect(r.content).toContain("refused by the guard");
    expect(r.content).toContain("#2 bash `echo after` — ok (exit 0)");
  });

  it("stopOnError skips what follows the first failure", async () => {
    const r = await createBatchTool().run(
      { stopOnError: true, phases: [{ ops: [{ op: "bash", command: "exit 3" }] }, { ops: [{ op: "read", path: "nope" }] }] },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("#1 bash `exit 3` — failed (exit 3)");
    expect(r.content).toContain("#2 read nope — not run");
    expect(r.content).toContain("#1 failed and stopOnError is set");
  });

  it("the batch wall clock bounds its commands and skips the rest", async () => {
    const r = await createBatchTool({ maxBatchSecs: 1 }).run(
      { ops: [{ op: "bash", command: "sleep 5" }, { op: "bash", command: "echo late" }] },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/#1 bash `sleep 5` — failed \((timed out after 1s|exit \d+)\)/);
    expect(r.content).toContain("#2 bash `echo late` — not run");
  }, 15_000);
});

describe("search glob", () => {
  it("narrows matches to files matching the glob", async () => {
    await writeFile(file("a.ts"), "token\n");
    await writeFile(file("a.md"), "token\n");
    const r = await searchTool.run({ pattern: "token", glob: "*.ts" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.ts");
    expect(r.content).not.toContain("a.md");
  });
});

describe("batch in the engine", () => {
  it("is one tool call: a read-edit-test sequence costs one model turn", async () => {
    const { runAgent } = await import("../../src/engine/loop.js");
    const { chatAgent } = await import("../../src/agents/chat/index.js");
    const { userTurn } = await import("../../src/engine/types.js");
    await writeFile(file("a.ts"), "export const n = 1;\n");
    const turns = [
      {
        calls: [
          {
            name: "batch",
            args: {
              phases: [
                { ops: [{ op: "read", path: "a.ts" }] },
                { ops: [{ op: "edit", path: "a.ts", old: "= 1", new: "= 2" }] },
                { ops: [{ op: "bash", command: "grep -c '= 2' a.ts" }] },
              ],
            },
          },
        ],
      },
      { text: "done" },
    ];
    let calls = 0;
    const result = await runAgent(userTurn("bump n"), {
      llm: {
        model: "scripted",
        complete: async () => {
          throw new Error("unexpected compaction");
        },
        stream: async (request) => {
          calls += 1;
          const turn = turns.shift()!;
          return {
            text: turn.text ?? "",
            toolCalls: (turn.calls ?? []).map((call, i) => ({
              id: `c-${request.messages.length}-${i}`,
              name: call.name,
              arguments: JSON.stringify(call.args),
            })),
            model: "scripted",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            latencyMs: 1,
          };
        },
      },
      sandbox,
      agent: chatAgent,
      tools: [createBatchTool()],
      budgets: { maxSteps: 5 },
    });
    expect(result).toMatchObject({ ok: true });
    expect(calls).toBe(2);
    expect(await readFile(file("a.ts"), "utf8")).toBe("export const n = 2;\n");
  });
});

describe("batch: retry safety", () => {
  it("an edit retried after it applied reports already applied, writes nothing, and is ok", async () => {
    await writeFile(file("a.ts"), "export const a = 2;\n");
    let writes = 0;
    const counting: Tool = { ...editFileTool, run: async (i, c) => ((writes += 1), editFileTool.run(i, c)) };
    const r = await createBatchTool({ tools: [readFileTool, searchTool, bashTool, counting] }).run(
      { ops: [{ op: "read", path: "a.ts" }, { op: "edit", path: "a.ts", old: "= 1", new: "= 2" }] },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(writes).toBe(0);
    expect(r.content).toContain("#2 edit a.ts — already applied (no change)");
    expect((r.meta as { ops: Array<{ status: string; alreadyApplied?: boolean }> }).ops[1]).toMatchObject({
      status: "ok",
      alreadyApplied: true,
    });
    expect(await readFile(file("a.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  it("an edit whose new contains old is not applied twice on retry", () => {
    const out = applyEdits("foo(bar)\n", [{ index: 1, old: "bar", new: "foo(bar)", replaceAll: false }]);
    expect(out).toMatchObject({ ok: true, content: "foo(bar)\n", stats: [{ alreadyApplied: true }] });
  });

  it("an ambiguous old still fails, and neither old nor new present still fails", () => {
    expect(applyEdits("x y x", [{ index: 3, old: "x", new: "y", replaceAll: false }])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("appears 2 times"),
    });
    expect(applyEdits("abc", [{ index: 2, old: "zzz", new: "qqq", replaceAll: true }])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('"old" not found'),
    });
    expect(applyEdits("abc", [{ index: 2, old: "zzz", new: "", replaceAll: false }])).toMatchObject({ ok: false });
  });

  it("a write whose target already has the content reports already applied", async () => {
    await writeFile(file("w.txt"), "same\n");
    const r = await createBatchTool().run({ ops: [{ op: "write", path: "w.txt", content: "same\n" }] }, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("#1 write w.txt — already applied (no change)");
    const changed = await createBatchTool().run({ ops: [{ op: "write", path: "w.txt", content: "other\n" }] }, ctx);
    expect(changed.content).toContain("#1 write w.txt — ok");
    expect(await readFile(file("w.txt"), "utf8")).toBe("other\n");
  });
});

describe("batch: stop after a failed write", () => {
  it("a batch that edits then fails a check stops by default and names the op", async () => {
    await writeFile(file("a.ts"), "one\n");
    const r = await createBatchTool().run(
      {
        ops: [
          { op: "edit", path: "a.ts", old: "one", new: "uno" },
          { op: "bash", command: "grep -q missing a.ts" },
          { op: "bash", command: "echo after" },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("#2 bash `grep -q missing a.ts` — failed (exit 1)");
    expect(r.content).toContain("#3 bash `echo after` — not run");
    expect(r.content).toContain("stopped after #2: #2 failed after a write, later ops not run");
    expect((r.meta as { stopped?: string }).stopped).toContain("stopped after #2");
  });

  it("a failed edit after a write says a write failed", async () => {
    await writeFile(file("a.ts"), "one\n");
    const r = await createBatchTool().run(
      {
        ops: [
          { op: "write", path: "b.ts", content: "b\n" },
          { op: "edit", path: "a.ts", old: "nope", new: "x" },
          { op: "bash", command: "echo after" },
        ],
      },
      ctx,
    );
    expect(r.content).toContain("stopped after #2: a write failed, later ops not run");
    expect(r.content).toContain("#3 bash `echo after` — not run");
  });

  it("a reads-only batch continues after a failure", async () => {
    await writeFile(file("a.ts"), "one\n");
    const r = await createBatchTool().run(
      { ops: [{ op: "read", path: "nope.ts" }, { op: "bash", command: "cat a.ts" }, { op: "bash", command: "exit 2" }, { op: "read", path: "a.ts" }] },
      ctx,
    );
    expect(r.content).toContain("#1 read nope.ts — failed");
    expect(r.content).toContain("#2 bash `cat a.ts` — ok");
    expect(r.content).toContain("#4 read a.ts — ok");
    expect(r.content).not.toContain("not run");
  });

  it("a failing first write does not stop the batch: nothing was written yet", async () => {
    await writeFile(file("a.ts"), "one\n");
    const r = await createBatchTool().run(
      { ops: [{ op: "edit", path: "a.ts", old: "nope", new: "x" }, { op: "bash", command: "echo after" }] },
      ctx,
    );
    expect(r.content).toContain("#2 bash `echo after` — ok");
  });

  it("an explicit stopOnError: false still continues after a write failure", async () => {
    await writeFile(file("a.ts"), "one\n");
    const r = await createBatchTool().run(
      {
        stopOnError: false,
        ops: [
          { op: "edit", path: "a.ts", old: "one", new: "uno" },
          { op: "edit", path: "a.ts", old: "nope", new: "x" },
          { op: "bash", command: "echo after" },
        ],
      },
      ctx,
    );
    expect(r.content).toContain("#3 bash `echo after` — ok");
    expect(r.content).not.toContain("stopped after");
  });

  it("isReadOnlyCommand: reads and checks are read-only, anything that may write is not", () => {
    for (const command of ["cat a.ts", "rg foo src | head -5", "git status && git diff", "npx vitest run a.test.ts 2>&1", "npm test", "sed -n '1,5p' a"])
      expect(isReadOnlyCommand(command), command).toBe(true);
    for (const command of ["echo x > a.ts", "sed -i s/a/b/ a", "npm install", "rm -rf x", "cat a | tee b", "eslint --fix .", "echo $(rm x)", "node script.js"])
      expect(isReadOnlyCommand(command), command).toBe(false);
  });
});
