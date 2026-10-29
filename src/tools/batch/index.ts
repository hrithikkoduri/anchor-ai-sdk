/**
 * batch — several known steps in ONE tool call.
 *
 * A model that already knows what it will do next (read these files, make
 * these edits, run this test) used to spend a model turn per step; at ~5 s a
 * turn, a short review was mostly waiting. A batch is ordered phases of ops:
 * reads and searches inside a phase run together, any phase with an edit,
 * write or command runs in order, and phases run one after another.
 *
 * Every op runs through the agent's OWN tool for it (`read_file`, `search`,
 * `bash`, `edit_file`), passed in as `tools`. Whatever guards a consumer
 * wrapped around those tools hold inside a batch exactly as outside it, and
 * an agent without a tool cannot reach it through a batch: the op is refused
 * on its own and the rest still run. `edit` and `write` need `edit_file`.
 *
 * Edits are all-or-nothing per file: every `old` must match (exactly once
 * unless `replaceAll`) against the file as the previous edits left it, and
 * the file is written once, through `edit_file`. One bad `old` leaves the
 * file untouched and the result names that edit. A retried edit or write
 * whose result is already in place reports `already applied` and writes
 * nothing, so a model resuming a partly applied batch sees no new failure.
 *
 * Once the batch has written (an edit, a write, or a bash the command
 * classifier cannot prove read-only), a later failure stops it by default: a
 * check must never run against a half-applied change. Before any write, a
 * failure leaves the rest running. An explicit `stopOnError` always wins.
 *
 * The batch is not read-only and declares no resource, so the engine runs it
 * alone: its writes hold the workspace for the whole call, and writes never
 * run in parallel — inside a batch or beside one.
 */
import { randomBytes } from "node:crypto";
import { shq, type Sandbox } from "../../sandbox/types.js";
import type { JsonObject } from "../../json.js";
import { defineTool, requireSandbox, type Tool, type ToolContext, type ToolResult } from "../types.js";
import { bashTool } from "../bash.js";
import { editFileTool } from "../edit-file.js";
import { readFileTool } from "../read-file.js";
import { searchTool } from "../search.js";
import { isReadOnlyCommand } from "./commands.js";
import { applyEdits, type FileEdit } from "./edits.js";
import {
  BATCH_CACHE_MAX_BYTES,
  cacheable,
  cacheDir,
  fileStamp,
  lookup,
  store,
  treeStamp,
  type BatchCacheOptions,
  type CacheLookup,
  type CacheQuery,
} from "./cache.js";
import { BATCH_MAX_OPS, parseBatch, type BatchUnit } from "./ops.js";
import { BATCH_RENDER_CAPS, failedTests, opLabel, renderBatch, type OpReport, type RenderCaps } from "./render.js";

export interface BatchToolOptions {
  /**
   * The tools ops run through, by name: read → `read_file`, search →
   * `search`, bash → `bash`, edit/write → `edit_file`. Pass the agent's own
   * (wrapped) tools so their guards apply per op. Default: the built-ins.
   */
  tools?: readonly Tool[];
  /** Map a path the model wrote to the one the tools would act on (cache keys, edits, writes). */
  resolvePath?: (path: string, ctx: ToolContext) => Promise<string>;
  /** Per-op cache for reads and searches; `false` turns it off. */
  cache?: BatchCacheOptions | false;
  /** Where the full log goes. Default `<sandbox.scratch>/batch`. */
  logDir?: string;
  /** Wall clock for the whole batch. Default 600 s. */
  maxBatchSecs?: number;
  caps?: Partial<RenderCaps>;
}

const OP_TOOL = { read: "read_file", search: "search", bash: "bash", edit: "edit_file", write: "edit_file" } as const;
const MAX_WRITE_CHARS = 100_000;
const READ_CONCURRENCY = 8;
const LOG_CHUNK_BYTES = 45_000;

interface UnitResult {
  report: OpReport;
  tool?: string;
  meta?: JsonObject;
  /** The op changed (or may have changed) the workspace, or found its change already there. */
  wrote?: boolean;
}

interface Run {
  ctx: ToolContext;
  /** The context each delegated op gets: the batch's signal, never a detach. */
  inner: ToolContext;
  sandbox: Sandbox;
  tools: Map<string, Tool>;
  options: BatchToolOptions;
  signal: AbortSignal;
  remainingSecs: () => number;
  cache?: { dir: string; maxBytes: number };
}

const targetOf = (unit: BatchUnit): string => {
  switch (unit.op) {
    case "read":
    case "edit":
    case "write":
      return unit.path;
    case "search":
      return `"${unit.pattern}"${unit.path ? ` in ${unit.path}` : ""}${unit.glob ? ` (${unit.glob})` : ""}`;
    case "bash":
      return unit.command;
    case "invalid":
      return unit.target;
  }
};

const reportFor = (unit: BatchUnit, status: OpReport["status"], body: string, extra: Partial<OpReport> = {}): OpReport => ({
  index: unit.index,
  op: unit.op === "invalid" ? unit.name : unit.op,
  target: targetOf(unit),
  status,
  body,
  ...extra,
});

function refused(run: Run, unit: BatchUnit): UnitResult | undefined {
  if (unit.op === "invalid") return { report: reportFor(unit, "failed", unit.error, { detail: "invalid op" }) };
  const name = OP_TOOL[unit.op];
  if (run.tools.has(name)) return undefined;
  return {
    report: reportFor(unit, "refused", `${unit.op} is not available to this agent: it has no ${name} tool.`),
  };
}

/** The op is one that changes the workspace (whether or not it got to). */
const writes = (report: OpReport) =>
  report.op === "edit" || report.op === "write" || (report.op === "bash" && !isReadOnlyCommand(report.target));

const metaOf = (result: ToolResult): JsonObject | undefined => result.meta;

const resolve = async (run: Run, path: string) => (run.options.resolvePath ? run.options.resolvePath(path, run.ctx) : path);

/** A read-only delegate abandoned at the batch deadline; it changes nothing. */
async function raced(run: Run, work: Promise<ToolResult>): Promise<ToolResult> {
  if (run.signal.aborted) return { ok: false, content: "not run: the batch was stopped" };
  return new Promise<ToolResult>((done) => {
    const stop = () => done({ ok: false, content: "stopped: the batch reached its time limit or was cancelled" });
    run.signal.addEventListener("abort", stop, { once: true });
    work.then(done, (err) => done({ ok: false, content: `error: ${err instanceof Error ? err.message : String(err)}` }))
      .finally(() => run.signal.removeEventListener("abort", stop));
  });
}

interface ReadPlan {
  unit: Extract<BatchUnit, { op: "read" | "search" }>;
  input: Record<string, unknown>;
  query?: CacheQuery;
}

async function planRead(run: Run, unit: Extract<BatchUnit, { op: "read" | "search" }>, id: string): Promise<ReadPlan> {
  const workspace = run.sandbox.workspace;
  if (unit.op === "read") {
    const path = await resolve(run, unit.path);
    const input = { path, ...(unit.offset !== undefined ? { offset: unit.offset } : {}), ...(unit.limit !== undefined ? { limit: unit.limit } : {}) };
    return { unit, input, query: { id, parts: { kind: "read", workspace, ...input }, stamp: fileStamp(path) } };
  }
  const path = unit.path ? await resolve(run, unit.path) : undefined;
  const input = {
    pattern: unit.pattern,
    ...(path ? { path } : {}),
    ...(unit.glob ? { glob: unit.glob } : {}),
    ...(unit.regex ? { regex: true } : {}),
  };
  return { unit, input, query: { id, parts: { kind: "search", workspace, ...input }, stamp: treeStamp(path ?? ".") } };
}

function readReport(unit: ReadPlan["unit"], result: ToolResult, cached: boolean): OpReport {
  const matches = (result.meta as { matches?: unknown } | undefined)?.matches;
  return reportFor(unit, result.ok ? "ok" : "failed", cached ? `${result.content}\n(cached)` : result.content, {
    ...(cached ? { cached: true } : {}),
    ...(unit.op === "search" && typeof matches === "number" ? { detail: `${matches} match${matches === 1 ? "" : "es"}` } : {}),
  });
}

/** Reads and searches: one cache lookup, the misses together, one store. */
async function runReads(run: Run, units: ReadonlyArray<ReadPlan["unit"]>): Promise<UnitResult[]> {
  const results: Array<UnitResult | undefined> = units.map((unit) => refused(run, unit));
  const plans = await Promise.all(
    units.map((unit, i) => (results[i] ? undefined : planRead(run, unit, String(i)))),
  );
  const queries = run.cache ? plans.flatMap((plan) => (plan?.query ? [plan.query] : [])) : [];
  const found = run.cache ? await lookup(run.sandbox, run.cache.dir, queries) : new Map<string, CacheLookup>();
  const toStore: Array<{ key: string; stamp: string; script: string; content: string }> = [];
  let next = 0;
  const worker = async () => {
    while (next < plans.length) {
      const i = next++;
      const plan = plans[i];
      if (!plan) continue;
      const tool = run.tools.get(OP_TOOL[plan.unit.op])!;
      const hit = found.get(String(i));
      if (hit?.state === "hit") {
        results[i] = { report: readReport(plan.unit, { ok: true, content: hit.content }, true), tool: tool.definition.name, meta: { cached: true } };
        continue;
      }
      const result = await raced(run, tool.run(plan.input, run.inner));
      if (hit?.state === "miss" && cacheable(result.ok, result.content))
        toStore.push({ key: hit.key, stamp: hit.stamp, script: hit.script, content: result.content });
      const meta = metaOf(result);
      results[i] = { report: readReport(plan.unit, result, false), tool: tool.definition.name, ...(meta ? { meta } : {}) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, plans.length) }, worker));
  if (run.cache) await store(run.sandbox, run.cache.dir, run.cache.maxBytes, toStore);
  return results.map((result) => result!);
}

async function runBash(run: Run, unit: Extract<BatchUnit, { op: "bash" }>): Promise<UnitResult> {
  const denied = refused(run, unit);
  if (denied) return denied;
  const tool = run.tools.get("bash")!;
  const timeout = Math.max(1, Math.min(unit.timeoutSecs ?? 120, run.remainingSecs()));
  const result = await tool.run(
    { command: unit.command, ...(unit.repository ? { repository: unit.repository } : {}), timeout_secs: timeout },
    run.inner,
  );
  const meta = (result.meta ?? {}) as { exitCode?: unknown; timedOut?: unknown; refused?: unknown };
  const exit = typeof meta.exitCode === "number" ? meta.exitCode : undefined;
  const failed = exit !== undefined && exit !== 0 ? failedTests(result.content) : undefined;
  const detail =
    meta.timedOut === true
      ? `timed out after ${timeout}s`
      : exit !== undefined
        ? `exit ${exit}${failed ? `, ${failed} failed` : ""}`
        : undefined;
  const status: OpReport["status"] = meta.refused === true ? "refused" : result.ok ? "ok" : "failed";
  return {
    report: reportFor(unit, status, result.content, detail ? { detail } : {}),
    tool: "bash",
    ...(status !== "refused" && !isReadOnlyCommand(unit.command) ? { wrote: true } : {}),
    ...(result.meta ? { meta: result.meta } : {}),
  };
}

/** Consecutive edits, one write per file; reports come back in op order. */
async function runEdits(run: Run, units: ReadonlyArray<Extract<BatchUnit, { op: "edit" }>>): Promise<UnitResult[]> {
  const out = new Map<Extract<BatchUnit, { op: "edit" }>, UnitResult>();
  const tool = run.tools.get("edit_file");
  if (!tool) return units.map((unit) => refused(run, unit)!);
  const files = new Map<string, Array<Extract<BatchUnit, { op: "edit" }>>>();
  for (const unit of units) {
    const path = await resolve(run, unit.path);
    files.set(path, [...(files.get(path) ?? []), unit]);
  }
  for (const [path, edits] of files) {
    const fail = (body: string, failedIndex?: number) => {
      for (const unit of edits)
        out.set(unit, {
          report: reportFor(
            unit,
            "failed",
            failedIndex === undefined || unit.index === failedIndex
              ? body
              : `not applied — edit #${failedIndex} on this file failed, so ${unit.path} was left untouched`,
          ),
        });
    };
    const read = await run.sandbox.exec(`wc -c < ${shq(path)} && cat ${shq(path)}`, { timeoutSecs: 60, concurrent: true });
    const newline = read.stdout.indexOf("\n");
    if (read.exitCode !== 0 || newline === -1) {
      fail(`cannot read ${path}: ${(read.stderr || read.output).trim() || "unknown error"} — file untouched`);
      continue;
    }
    const original = read.stdout.slice(newline + 1);
    const outcome = applyEdits(
      original,
      edits.map((unit): FileEdit => ({ index: unit.index, old: unit.old, new: unit.new, replaceAll: unit.replaceAll })),
    );
    if (!outcome.ok) {
      fail(`${outcome.reason}. ${path} was left untouched (no edit on it was applied).`, outcome.failed);
      continue;
    }
    if (outcome.content !== original) {
      const write = await tool.run({ path, old_string: original, new_string: outcome.content }, run.inner);
      if (!write.ok) {
        fail(`${write.content} — no edit on ${path} was applied`);
        continue;
      }
    }
    for (const stat of outcome.stats) {
      const unit = edits.find((item) => item.index === stat.index)!;
      out.set(unit, {
        report: reportFor(unit, "ok", "", stat.alreadyApplied
          ? { alreadyApplied: true, detail: "no change" }
          : { detail: `${stat.replacements} replacement${stat.replacements === 1 ? "" : "s"}, +${stat.added}/−${stat.removed}` }),
        tool: "edit_file",
        meta: {
          path,
          replacements: stat.replacements,
          added: stat.added,
          removed: stat.removed,
          ...(stat.alreadyApplied ? { alreadyApplied: true } : {}),
        },
        wrote: true,
      });
    }
  }
  return units.map((unit) => out.get(unit)!);
}

async function runWrite(run: Run, unit: Extract<BatchUnit, { op: "write" }>): Promise<UnitResult> {
  const denied = refused(run, unit);
  if (denied) return denied;
  if (unit.content.length > MAX_WRITE_CHARS)
    return { report: reportFor(unit, "failed", `write refuses content over ${MAX_WRITE_CHARS} characters — write a skeleton, then edit it`) };
  const path = await resolve(run, unit.path);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const expect = Buffer.byteLength(unit.content, "utf8");
  const current = await run.sandbox.exec(`[ -f ${shq(path)} ] && wc -c < ${shq(path)} && cat ${shq(path)}`, {
    timeoutSecs: 60,
    concurrent: true,
  });
  const newline = current.stdout.indexOf("\n");
  if (current.exitCode === 0 && newline !== -1 && current.stdout.slice(newline + 1) === unit.content)
    return {
      report: reportFor(unit, "ok", "", { alreadyApplied: true, detail: "no change" }),
      tool: "edit_file",
      meta: { path, bytes: expect, alreadyApplied: true },
      wrote: true,
    };
  const r = await run.sandbox.exec(
    `${dir ? `mkdir -p ${shq(dir)} && ` : ""}printf %s ${shq(unit.content)} | tee ${shq(path)} > /dev/null && wc -c < ${shq(path)}`,
    { timeoutSecs: 120 },
  );
  const bytes = Number.parseInt(r.stdout.trim(), 10);
  if (r.exitCode !== 0 || bytes !== expect)
    return {
      report: reportFor(
        unit,
        "failed",
        r.exitCode !== 0
          ? `write failed: ${(r.stderr || r.output).trim()}`
          : `write verification failed for ${path}: expected ${expect} bytes, file has ${bytes} — re-read it`,
      ),
    };
  const lines = unit.content === "" ? 0 : unit.content.split("\n").length - (unit.content.endsWith("\n") ? 1 : 0);
  return {
    report: reportFor(unit, "ok", "", { detail: `${lines} lines, ${expect} bytes` }),
    tool: "edit_file",
    meta: { path, bytes: expect },
    wrote: true,
  };
}

/** A sequential phase: in op order, runs of consecutive edits grouped per file. */
async function runSequential(
  run: Run,
  units: readonly BatchUnit[],
  stop: () => string | undefined,
  record: (results: UnitResult[]) => void,
): Promise<void> {
  for (let i = 0; i < units.length; ) {
    const unit = units[i]!;
    const reason = stop();
    if (reason) {
      record(units.slice(i).map((rest) => ({ report: reportFor(rest, "skipped", reason) })));
      return;
    }
    if (unit.op === "edit") {
      let end = i;
      while (end < units.length && units[end]!.op === "edit") end += 1;
      record(await runEdits(run, units.slice(i, end) as Array<Extract<BatchUnit, { op: "edit" }>>));
      i = end;
      continue;
    }
    if (unit.op === "read" || unit.op === "search") record(await runReads(run, [unit]));
    else if (unit.op === "bash") record([await runBash(run, unit)]);
    else if (unit.op === "write") record([await runWrite(run, unit)]);
    else record([refused(run, unit)!]);
    i += 1;
  }
}

async function writeLog(sandbox: Sandbox, file: string, text: string): Promise<boolean> {
  const dir = file.slice(0, file.lastIndexOf("/"));
  const bytes = Buffer.from(text, "utf8");
  try {
    const start = await sandbox.exec(`mkdir -p ${shq(dir)} && : > ${shq(file)}`, { timeoutSecs: 30, concurrent: true });
    if (start.exitCode !== 0) return false;
    for (let at = 0; at < bytes.length; at += LOG_CHUNK_BYTES) {
      const b64 = bytes.subarray(at, at + LOG_CHUNK_BYTES).toString("base64");
      const r = await sandbox.exec(`printf %s ${shq(b64)} | base64 -d >> ${shq(file)}`, { timeoutSecs: 30, concurrent: true });
      if (r.exitCode !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const OPS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["read", "search", "bash", "edit", "write"] },
      path: { type: "string", description: "read/edit/write: the file. search: the directory or file to search." },
      paths: { type: "array", items: { type: "string" }, description: "read: several files at once." },
      offset: { type: "integer", description: "read: first line (1-based)." },
      limit: { type: "integer", description: "read: how many lines (default 200)." },
      command: { type: "string", description: "bash: the shell command." },
      repository: { type: "string", description: "bash: the repository to run in." },
      timeout_secs: { type: "integer", description: "bash: kill deadline in seconds (default 120)." },
      old: { type: "string", description: "edit: exact text to replace — must match once." },
      new: { type: "string", description: "edit: the replacement (may be empty)." },
      replaceAll: { type: "boolean", description: "edit: replace every occurrence of old." },
      content: { type: "string", description: "write: the whole new file content." },
      pattern: { type: "string", description: "search: the text to find." },
      glob: { type: "string", description: "search: only files matching this glob." },
      regex: { type: "boolean", description: "search: pattern is a regular expression." },
    },
    required: ["op"],
  },
} as const;

export function createBatchTool(options: BatchToolOptions = {}): Tool {
  const tools = new Map(
    (options.tools ?? [readFileTool, searchTool, bashTool, editFileTool]).map((tool) => [tool.definition.name, tool]),
  );
  const maxBatchSecs = Math.max(1, options.maxBatchSecs ?? 600);
  const caps = { ...BATCH_RENDER_CAPS, ...options.caps };
  return defineTool(
    {
      name: "batch",
      description:
        `Run several steps you already know in ONE call (one turn): read files, search, edit, write, run commands — in the order you would do them. ` +
        `Reach for it whenever the next several steps are already decided: reading three files and running one grep is one call, not four. ` +
        `Ops in a phase that only read or search run together; a phase with an edit, write or bash runs in order; phases run one after another. ` +
        `Edits to one file are all-or-nothing: every "old" must match exactly once (or set replaceAll), else the file is left untouched and the failing edit is named. ` +
        `A retry of an edit that already applied reports \`already applied\`. ` +
        `Each op reports on its own line (#n op target — ok/failed). After a failed write the batch stops; fix and continue from that op. ` +
        `Before anything is written a failed op does not stop the rest; an explicit stopOnError (true or false) overrides both. ` +
        `At most ${BATCH_MAX_OPS} ops (each read path counts); long output is clipped and the full log path is given. Unchanged files and searches come back marked (cached).`,
      parameters: {
        type: "object",
        properties: {
          phases: {
            type: "array",
            description: "Ordered phases; each holds ops that belong together.",
            items: { type: "object", properties: { ops: OPS_SCHEMA }, required: ["ops"] },
          },
          ops: { ...OPS_SCHEMA, description: "A single phase (instead of phases)." },
          stopOnError: {
            type: "boolean",
            description:
              "true: skip everything after the first failed op. false: always run every op. Default: stop only when an op fails after the batch has written.",
          },
        },
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const parsed = parseBatch(input);
      if ("error" in parsed) return { ok: false, content: parsed.error };
      const sandbox = requireSandbox(ctx);
      const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
      const log = `${options.logDir ?? `${sandbox.scratch}/batch`}/${id}.log`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), maxBatchSecs * 1000);
      timer.unref?.();
      const onCancel = () => controller.abort();
      ctx.signal?.addEventListener("abort", onCancel, { once: true });
      if (ctx.signal?.aborted) controller.abort();
      const started = Date.now();
      // Delegates never detach: a backgrounded command inside a batch would
      // have no tool call of its own to be delivered to.
      const { backgroundAfterSecs: _detach, ...base } = ctx;
      const run: Run = {
        ctx,
        inner: { ...base, signal: controller.signal },
        sandbox,
        tools,
        options,
        signal: controller.signal,
        remainingSecs: () => Math.max(1, Math.floor(maxBatchSecs - (Date.now() - started) / 1000)),
        ...(options.cache === false
          ? {}
          : { cache: { dir: cacheDir(sandbox, options.cache ?? {}), maxBytes: options.cache?.maxBytes ?? BATCH_CACHE_MAX_BYTES } }),
      };

      const results: UnitResult[] = [];
      let failedAt: number | undefined;
      let wrote = false;
      let stopped: string | undefined;
      const record = (batch: UnitResult[]) => {
        results.push(...batch);
        for (const item of batch) {
          if (item.report.status === "failed" || item.report.status === "refused") {
            failedAt ??= item.report.index;
            if (wrote && stopped === undefined)
              stopped = `stopped after #${item.report.index}: ${
                writes(item.report) ? "a write failed" : `#${item.report.index} failed after a write`
              }, later ops not run`;
          }
          if (item.wrote) wrote = true;
        }
      };
      const stop = (): string | undefined => {
        if (ctx.signal?.aborted) return "not run: the batch was cancelled";
        if (controller.signal.aborted) return `not run: the batch reached its ${maxBatchSecs}s limit`;
        if (parsed.stopOnError === true && failedAt !== undefined) return `not run: #${failedAt} failed and stopOnError is set`;
        if (parsed.stopOnError === undefined && stopped) return `not run: ${stopped}`;
        return undefined;
      };
      try {
        for (const phase of parsed.phases) {
          if (!phase.concurrent) {
            await runSequential(run, phase.units, stop, record);
            continue;
          }
          const reason = stop();
          if (reason) {
            record(phase.units.map((unit) => ({ report: reportFor(unit, "skipped", reason) })));
            continue;
          }
          const reads = phase.units.filter((unit): unit is ReadPlan["unit"] => unit.op === "read" || unit.op === "search");
          const readResults = await runReads(run, reads);
          record(phase.units.map((unit) => (unit.op === "invalid" ? refused(run, unit)! : readResults[reads.indexOf(unit as ReadPlan["unit"])]!)));
        }
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onCancel);
      }

      const reports = results.map((item) => item.report);
      const count = (status: OpReport["status"]) => reports.filter((report) => report.status === status).length;
      const okCount = count("ok");
      const failed = count("failed") + count("refused");
      const skipped = count("skipped");
      const halted = parsed.stopOnError === undefined && skipped > 0 ? stopped : undefined;
      const saved = await writeLog(
        sandbox,
        log,
        reports.map((report) => [opLabel(report), report.body.trimEnd()].filter(Boolean).join("\n")).join("\n\n") + "\n",
      );
      const logNote = saved ? `full output in ${log}` : "the full log could not be saved";
      const header = `batch ${id}: ${reports.length} result${reports.length === 1 ? "" : "s"} — ${okCount} ok${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} not run` : ""}.${halted ? ` ${halted} — fix it and continue from that op.` : ""} Full log: ${saved ? log : "(could not be saved)"}`;
      const rendered = renderBatch(reports, header, logNote, caps);
      return {
        ok: failed === 0 && skipped === 0,
        content: rendered.content,
        verb: `Running ${parsed.units} step${parsed.units === 1 ? "" : "s"} in one batch`,
        meta: {
          batchId: id,
          log,
          logSaved: saved,
          clipped: rendered.clipped,
          ok: okCount,
          failed,
          skipped,
          ...(halted ? { stopped: halted } : {}),
          ops: results.map((item) => ({
            index: item.report.index,
            op: item.report.op,
            target: item.report.target.slice(0, 300),
            status: item.report.status,
            ...(item.report.cached ? { cached: true } : {}),
            ...(item.report.alreadyApplied ? { alreadyApplied: true } : {}),
            ...(item.tool ? { tool: item.tool } : {}),
            ...(item.meta ? { meta: item.meta } : {}),
          })),
        },
      };
    },
    {
      verb: (input) => {
        const parsed = parseBatch(input);
        return "error" in parsed ? "Running a batch of steps" : `Running ${parsed.units} step${parsed.units === 1 ? "" : "s"} in one batch`;
      },
    },
  );
}

export { applyEdits, lineDelta } from "./edits.js";
export { parseBatch, BATCH_MAX_OPS } from "./ops.js";
export type { BatchUnit, ParsedBatch } from "./ops.js";
export { allotment, renderBatch, BATCH_RENDER_CAPS } from "./render.js";
export type { OpReport, RenderCaps } from "./render.js";
export type { BatchCacheOptions } from "./cache.js";
