/**
 * The generic eval runner — tasks in, arms run, patches out.
 *
 * Deliberately knows nothing about SWE-bench, Docker, or Sailor: it walks a
 * task list, gives each task a fresh sandbox from the provider, hands the
 * sandbox to an arm, extracts the final diff, and reports. That is the whole
 * contract — the future Anchor lift (`anchor eval`) is this module, once its
 * shape has survived real runs.
 *
 * Failure is data, not an exception: a task that throws yields a result with
 * `status: "failed"` (and a best-effort patch — partial work is still worth
 * recording). The suite always finishes.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentEvent,
  BudgetLimits,
  CompactionConfig,
  LLMClient,
  LLMUsage,
  Sandbox,
  SandboxProvider,
} from "anchor-ai-sdk";
import type { EvalTask } from "./tasks.js";

export interface ArmOutcome {
  usage?: LLMUsage;
  steps?: number;
  reason?: string;
  summary?: string;
}

export interface EvalArmContext {
  sandbox: Sandbox;
  llm: LLMClient;
  budgets?: Partial<BudgetLimits>;
  compaction?: CompactionConfig;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Directory for side artifacts (trajectories etc.), when the caller has one. */
  artifactsDir?: string;
}

/** A system under test. It works inside the sandbox; the runner extracts the diff. */
export interface EvalArm {
  name: string;
  run(task: EvalTask, ctx: EvalArmContext): Promise<ArmOutcome | void>;
}

export interface EvalTaskResult {
  taskId: string;
  arm: string;
  status: "completed" | "failed";
  /** The task's final diff — the graded artifact (empty string when nothing changed). */
  patch: string;
  error?: string;
  usage?: LLMUsage;
  steps?: number;
  reason?: string;
  wallMs: number;
}

export interface EvalRunOptions {
  tasks: EvalTask[];
  arm: EvalArm;
  provider: SandboxProvider;
  llm: LLMClient;
  budgets?: Partial<BudgetLimits>;
  compaction?: CompactionConfig;
  signal?: AbortSignal;
  /** Called as each task finishes — where predictions and traces get written. */
  onResult?: (result: EvalTaskResult) => Promise<void> | void;
  /** Every engine event of every task, tagged with its task. */
  onEvent?: (task: EvalTask, event: AgentEvent) => void;
  /** Directory for side artifacts (mini's trajectories etc.). */
  artifactsDir?: string;
  log?: (line: string) => void;
}

/**
 * The workspace's final diff, staged first so untracked files are included,
 * diffed against the sandbox's OWN pre-run HEAD.
 *
 * Never the task's `baseRef`: benchmark images ship the repo at a commit
 * whose file modes already differ from the dataset's base_commit, and diffing
 * against base_commit turns that drift into >100 mode-only blocks around the
 * real change. The pre-run HEAD is the sandbox's actual starting state, so
 * the diff is the agent's work exactly — and a committing agent's commits
 * still count, because the index is compared to that pre-run commit.
 */
async function extractPatch(
  sandbox: Sandbox,
  headRef: string,
): Promise<string> {
  const diff = await sandbox.exec(
    `git add -A && git diff --cached --binary ${headRef} -- . ':(exclude).anchor'`,
    { timeoutSecs: 120 },
  );
  if (diff.exitCode !== 0) {
    // A degraded repo may not resolve the ref — report the worktree as-is.
    const fallback = await sandbox.exec(
      `git add -A && git diff --cached --binary -- . ':(exclude).anchor'`,
      { timeoutSecs: 120 },
    );
    // BOTH failing means the sandbox is broken (paused? gone?) — a TOOLING
    // failure, and it must be loud: silently returning "" turns a lost patch
    // into an innocent-looking empty one (2026-10-18: an xarray attempt's
    // real 1k-char fix died this way and read as "agent did nothing").
    if (fallback.exitCode !== 0) {
      throw new Error(
        `patch extraction failed (git diff exited ${diff.exitCode}, ${fallback.exitCode}): ${fallback.output.trim().slice(0, 300)}`,
      );
    }
    return fallback.stdout;
  }
  return diff.stdout;
}

/**
 * Carry the agent's notes file out of the sandbox at task end — the same
 * artifact seam mini's trajectories use — so every run leaves a per-task
 * reasoning trail next to the official verdict. Best-effort by design.
 */
async function captureNotes(
  sandbox: Sandbox,
  taskId: string,
  artifactsDir?: string,
): Promise<void> {
  if (!artifactsDir) return;
  const notes = await sandbox.exec("cat .anchor/notes.md", { timeoutSecs: 30 });
  if (notes.exitCode !== 0 || !notes.stdout.trim()) return;
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, `anchor-${taskId}.notes.md`),
    notes.stdout,
  );
}

export async function runEvalSuite(
  options: EvalRunOptions,
): Promise<EvalTaskResult[]> {
  const results: EvalTaskResult[] = [];
  for (const task of options.tasks) {
    const started = Date.now();
    options.log?.(`→ ${task.id}`);
    const sandbox = options.provider.create(
      task.image
        ? {
            image: task.image,
            ...(task.workspacePath
              ? { workspacePath: task.workspacePath }
              : {}),
            ...(task.env ? { env: task.env } : {}),
            gitIdentity: { name: "anchor-eval", email: "eval@anchor.local" },
          }
        : {
            repoUrl: task.repoUrl,
            ref: task.baseRef,
            ...(task.env ? { env: task.env } : {}),
            gitIdentity: { name: "anchor-eval", email: "eval@anchor.local" },
          },
    );

    let result: EvalTaskResult;
    let headRef = task.baseRef;
    try {
      await sandbox.start();
      // The pre-run commit: extraction diffs against THIS, never the task's
      // base_ref (image tasks carry mode drift versus the dataset commit).
      const head = await sandbox.exec("git rev-parse HEAD", {
        timeoutSecs: 60,
      });
      if (head.exitCode === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim())) {
        headRef = head.stdout.trim();
      }
      const outcome =
        (await options.arm.run(task, {
          sandbox,
          llm: options.llm,
          ...(options.artifactsDir
            ? { artifactsDir: options.artifactsDir }
            : {}),
          ...(options.budgets ? { budgets: options.budgets } : {}),
          ...(options.compaction ? { compaction: options.compaction } : {}),
          ...(options.onEvent
            ? { onEvent: (event: AgentEvent) => options.onEvent?.(task, event) }
            : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })) ?? {};
      result = {
        taskId: task.id,
        arm: options.arm.name,
        status: "completed",
        patch: await extractPatch(sandbox, headRef),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(outcome.steps !== undefined ? { steps: outcome.steps } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        wallMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const patch = await extractPatch(sandbox, headRef).catch(() => "");
      result = {
        taskId: task.id,
        arm: options.arm.name,
        status: "failed",
        patch,
        error: message,
        wallMs: Date.now() - started,
      };
    } finally {
      // Carry the agent's own notes out for the record (best-effort), then
      // release the sandbox.
      await captureNotes(sandbox, task.id, options.artifactsDir).catch(
        () => undefined,
      );
      await sandbox.destroy().catch(() => {});
    }

    results.push(result);
    await options.onResult?.(result);
  }
  return results;
}
