/**
 * The generic eval runner — tasks in, arms run, patches and checks out.
 *
 * Deliberately knows nothing about SWE-bench, Docker, or Sailor: it walks a
 * task list, gives each task a fresh sandbox from the provider, hands the
 * sandbox to an arm, extracts the final diff, runs any dense checks, and
 * reports. That is the whole contract.
 *
 * Failure is data, not an exception: a task that throws yields a result with
 * `status: "failed"` (and a best-effort patch — partial work is still worth
 * recording), and a task that hits its wall-clock budget still runs its checks
 * so partial progress is measured. The suite always finishes.
 */
import { execFileSync } from "node:child_process";
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
import type { EvalCheck, EvalTask } from "./tasks.js";

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
  sampling?: { temperature?: number; seed?: number };
  /** Which harness variant this arm should run (baseline, progress, ...). */
  variant?: string;
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

export interface EvalCheckResult {
  id: string;
  ok: boolean;
  exitCode: number;
  /** Tail of the command's output, for diagnosis. */
  output: string;
  weight: number;
}

export interface EvalTaskResult {
  taskId: string;
  arm: string;
  variant?: string;
  status: "completed" | "failed" | "timeout";
  /** The task's final diff — the graded artifact (empty string when nothing changed). */
  patch: string;
  error?: string;
  usage?: LLMUsage;
  steps?: number;
  reason?: string;
  wallMs: number;
  /** Weighted check score in [0,1]; absent for SWE-bench (external grader). */
  reward?: number;
  checks?: EvalCheckResult[];
  timedOut?: boolean;
  /** The arm declared finished while checks still failed. */
  falseFinish?: boolean;
}

export interface EvalRunOptions {
  tasks: EvalTask[];
  arm: EvalArm;
  provider: SandboxProvider;
  llm: LLMClient;
  /** Applied after setup; `"none"` needs a provider with egressControl. */
  egress?: "full" | "none";
  budgets?: Partial<BudgetLimits>;
  /** Wall-clock ceiling for every task; overrides the task's own budget. */
  timeBudgetSecs?: number;
  compaction?: CompactionConfig;
  sampling?: { temperature?: number; seed?: number };
  variant?: string;
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
 * Run a harness task's weighted checks. Every check runs even when an earlier
 * one fails, because partial credit is the point.
 */
async function runChecks(
  sandbox: Sandbox,
  checks: EvalCheck[],
): Promise<{ results: EvalCheckResult[]; reward: number | undefined }> {
  const results: EvalCheckResult[] = [];
  for (const check of checks) {
    const weight = check.weight ?? 1;
    try {
      const result = await sandbox.exec(check.command, {
        timeoutSecs: check.timeoutSecs ?? 120,
      });
      results.push({
        id: check.id,
        ok: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        output: result.output.slice(-2000),
        weight,
      });
    } catch (error) {
      results.push({
        id: check.id,
        ok: false,
        exitCode: -1,
        output: error instanceof Error ? error.message : String(error),
        weight,
      });
    }
  }
  const total = results.reduce((sum, check) => sum + check.weight, 0);
  const passed = results.reduce(
    (sum, check) => sum + (check.ok ? check.weight : 0),
    0,
  );
  return { results, reward: total > 0 ? passed / total : undefined };
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
  const notes = await sandbox.exec("cat .anchor/notes.md", {
    timeoutSecs: 30,
    concurrent: true,
  });
  if (notes.exitCode !== 0 || !notes.stdout.trim()) return;
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, `anchor-${taskId}.notes.md`),
    notes.stdout,
  );
}

/**
 * Materialize a local fixture inside a remote sandbox.
 *
 * Remote providers (heyo, e2b) have no host-path copy. The fixture is small,
 * so tar+base64 into one command is simpler and more reliable than a file
 * protocol the sandbox contract does not have. The workspace is cleared first:
 * a benchmark VM is disposable, and the fixture is the entire task.
 */
async function uploadFixture(
  sandbox: Sandbox,
  dir: string,
): Promise<void> {
  const archive = execFileSync("tar", ["-czf", "-", "-C", dir, "."], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const encoded = archive.toString("base64");
  const command = [
    "find . -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true",
    "cat > .anchor-fixture.b64 <<'ANCHOR_FIXTURE'",
    encoded,
    "ANCHOR_FIXTURE",
    "base64 -d .anchor-fixture.b64 | tar -xzf - -C .",
    "rm -f .anchor-fixture.b64",
  ].join("\n");
  const result = await sandbox.exec(command, { timeoutSecs: 180 });
  if (result.exitCode !== 0) {
    throw new Error(
      `fixture upload failed (exit ${result.exitCode}): ${result.output.trim().slice(0, 500)}`,
    );
  }
}

/** Apply SWE-bench's official test patch after the agent's patch is captured. */
async function applyTestPatch(
  sandbox: Sandbox,
  patchText: string,
): Promise<{ ok: boolean; output: string }> {
  const encoded = Buffer.from(patchText).toString("base64");
  const command = [
    `echo '${encoded}' | base64 -d > .anchor-test.patch`,
    "git apply .anchor-test.patch",
    "code=$?",
    "rm -f .anchor-test.patch",
    "exit $code",
  ].join("\n");
  const result = await sandbox.exec(command, { timeoutSecs: 120 });
  return { ok: result.exitCode === 0, output: result.output };
}

export async function runEvalSuite(
  options: EvalRunOptions,
): Promise<EvalTaskResult[]> {
  const results: EvalTaskResult[] = [];
  for (const task of options.tasks) {
    const started = Date.now();
    options.log?.(`→ ${task.id}`);
    const sandbox = options.provider.create(
      task.localPath
        ? {
            localPath: task.localPath,
            gitIdentity: { name: "anchor-eval", email: "eval@anchor.local" },
          }
        : task.image
          ? {
              image: task.image,
              ...(task.workspacePath
                ? { workspacePath: task.workspacePath }
                : {}),
              ...(task.env ? { env: task.env } : {}),
              ...(options.egress ? { egress: options.egress } : {}),
              gitIdentity: { name: "anchor-eval", email: "eval@anchor.local" },
            }
          : task.workspacePath
            ? {
                workspacePath: task.workspacePath,
                ...(task.env ? { env: task.env } : {}),
                ...(options.egress ? { egress: options.egress } : {}),
                gitIdentity: { name: "anchor-eval", email: "eval@anchor.local" },
              }
            : {
                repoUrl: task.repoUrl,
                ...(task.baseRef ? { ref: task.baseRef } : {}),
                ...(task.env ? { env: task.env } : {}),
                ...(options.egress ? { egress: options.egress } : {}),
                gitIdentity: { name: "anchor-eval", email: "eval@anchor.local" },
              },
    );

    let result: EvalTaskResult;
    let headRef = task.baseRef ?? "HEAD";
    try {
      await sandbox.start();
      // A remote provider has no host-path copy; materialize the fixture now.
      if (
        task.localPath &&
        options.provider.capabilities.localPath === false
      ) {
        await uploadFixture(sandbox, task.localPath);
      }
      // A clone-based remote run installs its own dependencies; an
      // image-backed run usually has none. Best-effort: a missing dependency
      // is a task failure to measure, not a reason to abort the suite.
      for (const command of task.setup ?? []) {
        const setup = await sandbox.exec(command, { timeoutSecs: 300 });
        if (setup.exitCode !== 0) {
          options.log?.(
            `setup failed (exit ${setup.exitCode}): ${command} — ${setup.output.trim().slice(0, 200)}`,
          );
        }
      }
      // The pre-run commit: extraction diffs against THIS, never the task's
      // base_ref (image tasks carry mode drift versus the dataset commit).
      // Local fixtures may arrive without a commit — make one so the diff is
      // exactly the agent's work, not the fixture's own files.
      let head = await sandbox.exec("git rev-parse HEAD", {
        timeoutSecs: 60,
      });
      if (head.exitCode !== 0) {
        await sandbox.exec(
          "git add -A && git commit -qm baseline --allow-empty",
          { timeoutSecs: 60 },
        );
        head = await sandbox.exec("git rev-parse HEAD", { timeoutSecs: 60 });
      }
      if (head.exitCode === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim())) {
        headRef = head.stdout.trim();
      }

      const controller = new AbortController();
      let timedOut = false;
      const timeBudgetSecs = options.timeBudgetSecs ?? task.timeBudgetSecs;
      const timer =
        timeBudgetSecs !== undefined && timeBudgetSecs > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeBudgetSecs * 1000)
          : undefined;

      let outcome: ArmOutcome = {};
      let failure: string | undefined;
      try {
        outcome =
          (await options.arm.run(task, {
            sandbox,
            llm: options.llm,
            ...(options.artifactsDir
              ? { artifactsDir: options.artifactsDir }
              : {}),
            ...(options.budgets ? { budgets: options.budgets } : {}),
            ...(options.compaction ? { compaction: options.compaction } : {}),
            ...(options.sampling ? { sampling: options.sampling } : {}),
            ...(options.variant ? { variant: options.variant } : {}),
            ...(options.onEvent
              ? {
                  onEvent: (event: AgentEvent) =>
                    options.onEvent?.(task, event),
                }
              : {}),
            signal: controller.signal,
          })) ?? {};
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      // A leaked `cmd &` child is not one the engine tracks. Drain it before
      // the diff/test patch: a busy sandbox must not read as a failed task.
      await sandbox.killAllJobs?.().catch(() => undefined);

      // Capture the agent's patch BEFORE the official test patch lands, so the
      // deliverable stays the agent's work. Then apply the test patch, exactly
      // as the official grader does, and run the dense checks.
      const patch = await extractPatch(sandbox, headRef).catch(
        (error: unknown) => {
          failure ??= `patch extraction failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          return "";
        },
      );

      let testPatchOk = true;
      if (task.testPatch && task.checks?.length) {
        const applied = await applyTestPatch(sandbox, task.testPatch);
        testPatchOk = applied.ok;
        if (!applied.ok) {
          failure ??=
            `test patch failed to apply: ${applied.output.trim().slice(0, 300)}`;
        }
      }

      // Dense checks run after a normal finish, an abort, or a throw: partial
      // progress is the measurement. A broken sandbox marks the task failed.
      let reward: number | undefined;
      let checks: EvalCheckResult[] | undefined;
      if (task.checks?.length && testPatchOk) {
        try {
          const outcomeChecks = await runChecks(sandbox, task.checks);
          checks = outcomeChecks.results;
          reward = outcomeChecks.reward;
        } catch (error) {
          failure ??= `checks failed to run: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      const falseFinish =
        outcome.reason === "finished" &&
        reward !== undefined &&
        reward < 0.95;

      result = {
        taskId: task.id,
        arm: options.arm.name,
        ...(options.variant ? { variant: options.variant } : {}),
        status: failure
          ? "failed"
          : timedOut
            ? "timeout"
            : "completed",
        patch,
        ...(failure ? { error: failure } : {}),
        ...(timedOut
          ? {
              error:
                failure ??
                `wall-clock budget of ${timeBudgetSecs}s exceeded`,
            }
          : {}),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(outcome.steps !== undefined ? { steps: outcome.steps } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        ...(reward !== undefined ? { reward } : {}),
        ...(checks ? { checks } : {}),
        ...(falseFinish ? { falseFinish: true } : {}),
        wallMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const patch = await extractPatch(sandbox, headRef).catch(() => "");
      result = {
        taskId: task.id,
        arm: options.arm.name,
        ...(options.variant ? { variant: options.variant } : {}),
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
