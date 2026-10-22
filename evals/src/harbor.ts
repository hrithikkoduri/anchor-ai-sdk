/**
 * Harbor task runner: SWE-bench Pro V2 and Terminal-Bench 2.1 both ship
 * self-contained task directories (task.toml, instruction.md, tests/).
 *
 * SWE-bench Pro uses the locked protocol: the agent's git diff is captured and
 * replayed in a pristine container before the task's verifier runs. Terminal-
 * Bench is state-based: the verifier runs in the agent's container.
 *
 * This is deliberately separate from the SWE-bench patch adapter in runner.ts.
 * The task's own test.sh owns the verdict; we only supply the image, the
 * workspace, the tests, and a fresh container when the protocol requires one.
 */
import { execFileSync } from "node:child_process";
import type { Sandbox } from "anchor-ai-sdk";
import type { EvalTask } from "./tasks.js";
import { extractPatch, untrackedFiles } from "./patch.js";
import type {
  ArmOutcome,
  EvalRunOptions,
  EvalTaskResult,
} from "./runner.js";

const MAX_ARCHIVE = 128 * 1024 * 1024;

/** Copy a host directory into the sandbox without a host bind mount. */
async function uploadTree(
  sandbox: Sandbox,
  dir: string,
  destination: string,
): Promise<void> {
  const archive = execFileSync("tar", ["-czf", "-", "-C", dir, "."], {
    maxBuffer: MAX_ARCHIVE,
  });
  const encoded = archive.toString("base64");
  const command = [
    `mkdir -p ${destination}`,
    "cat > /tmp/anchor-tree.b64 <<'ANCHOR_TREE'",
    encoded,
    "ANCHOR_TREE",
    `base64 -d /tmp/anchor-tree.b64 | tar -xzf - -C ${destination}`,
    "rm -f /tmp/anchor-tree.b64",
  ].join("\n");
  const result = await sandbox.exec(command, { timeoutSecs: 300 });
  if (result.exitCode !== 0) {
    throw new Error(
      `task files upload failed (exit ${result.exitCode}): ${result.output.trim().slice(0, 500)}`,
    );
  }
}

async function applyPatch(sandbox: Sandbox, patch: string): Promise<void> {
  if (!patch.trim()) throw new Error("agent produced an empty patch");
  const encoded = Buffer.from(patch).toString("base64");
  // A real SWE-bench Pro diff can be megabytes; passing it through one
  // `docker exec` argument hits E2BIG (observed on NodeBB). Stream it in
  // argument-safe chunks instead.
  const chunkSize = 64 * 1024;
  await sandbox.exec("rm -f /tmp/anchor-agent.patch.b64 && : > /tmp/anchor-agent.patch.b64", {
    timeoutSecs: 30,
  });
  for (let offset = 0; offset < encoded.length; offset += chunkSize) {
    const chunk = encoded.slice(offset, offset + chunkSize);
    const write = await sandbox.exec(
      `printf '%s' '${chunk}' >> /tmp/anchor-agent.patch.b64`,
      { timeoutSecs: 60 },
    );
    if (write.exitCode !== 0) {
      throw new Error(
        `agent patch upload failed (exit ${write.exitCode}): ${write.output.trim().slice(0, 300)}`,
      );
    }
  }
  const command = [
    "base64 -d /tmp/anchor-agent.patch.b64 > /tmp/anchor-agent.patch",
    "git apply --binary --verbose /tmp/anchor-agent.patch",
    "code=$?",
    "rm -f /tmp/anchor-agent.patch /tmp/anchor-agent.patch.b64",
    "exit $code",
  ].join("\n");
  const result = await sandbox.exec(command, { timeoutSecs: 300 });
  if (result.exitCode !== 0) {
    throw new Error(
      `agent patch failed to apply (exit ${result.exitCode}): ${result.output.trim().slice(0, 800)}`,
    );
  }
}

interface VerifierResult {
  reward: number;
  exitCode: number;
  output: string;
  timedOut: boolean;
}

/**
 * Install the task's verifier and run it. The script owns the reward file;
 * a missing file falls back to the process exit code so an infrastructure
 * failure is never silently scored as a pass.
 */
async function runVerifier(
  sandbox: Sandbox,
  task: EvalTask,
): Promise<VerifierResult> {
  if (!task.testsDir) throw new Error(`${task.id} has no tests directory`);
  await uploadTree(sandbox, task.testsDir, "/tests");
  await sandbox.exec("mkdir -p /logs/verifier", { timeoutSecs: 30 });
  const run = await sandbox.exec("bash /tests/test.sh", {
    timeoutSecs: task.verifierTimeoutSecs ?? 900,
  });
  const rewardText = await sandbox
    .exec("cat /logs/verifier/reward.txt", {
      timeoutSecs: 30,
      concurrent: true,
    })
    .catch(() => undefined);
  const parsed = Number.parseFloat(rewardText?.stdout.trim() ?? "");
  const reward = Number.isFinite(parsed)
    ? parsed
    : run.exitCode === 0
      ? 1
      : 0;
  return {
    reward: Math.min(1, Math.max(0, reward)),
    exitCode: run.exitCode,
    output: run.output.slice(-8000),
    timedOut: run.timedOut,
  };
}

/** Boot a task image. The caller owns start/destroy. */
function createTaskSandbox(
  task: EvalTask,
  options: EvalRunOptions,
  verifier = false,
) {
  return options.provider.create({
    image: task.image!,
    ...(task.workspacePath ? { workspacePath: task.workspacePath } : {}),
    ...(task.env ? { env: task.env } : {}),
    ...(!verifier && task.agentEgress
      ? { egress: task.agentEgress }
      : {}),
    gitIdentity: { name: "anchor-eval", email: "eval@anchor.local" },
  });
}

export async function runHarborTask(
  task: EvalTask,
  options: EvalRunOptions,
): Promise<EvalTaskResult> {
  const started = Date.now();
  let sandbox: Sandbox | undefined;
  let verifierSandbox: Sandbox | undefined;
  let outcome: ArmOutcome = {};
  let failure: string | undefined;
  let timedOut = false;
  let patch = "";
  let baselineUntracked: string[] = [];
  let verifier: VerifierResult;
  let result: EvalTaskResult;

  try {
    sandbox = createTaskSandbox(task, options);
    await sandbox.start();
    let headRef = "HEAD";
    const head = await sandbox.exec("git rev-parse HEAD", { timeoutSecs: 60 });
    if (head.exitCode === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim())) {
      headRef = head.stdout.trim();
    }
    baselineUntracked = await untrackedFiles(sandbox);

    const controller = new AbortController();
    const timeBudgetSecs = options.timeBudgetSecs ?? task.timeBudgetSecs;
    const timer =
      timeBudgetSecs !== undefined && timeBudgetSecs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeBudgetSecs * 1000)
        : undefined;
    try {
      outcome =
        (await options.arm.run(task, {
          sandbox,
          llm: options.llm,
          ...(options.artifactsDir ? { artifactsDir: options.artifactsDir } : {}),
          ...(options.budgets ? { budgets: options.budgets } : {}),
          ...(options.compaction ? { compaction: options.compaction } : {}),
          ...(options.sampling ? { sampling: options.sampling } : {}),
          ...(options.variant ? { variant: options.variant } : {}),
          ...(options.onEvent
            ? { onEvent: (event) => options.onEvent?.(task, event) }
            : {}),
          signal: controller.signal,
        })) ?? {};
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // A leaked `cmd &` child can hold the single-flight gate; drain it before
    // snapshotting or running the verifier.
    await sandbox.killAllJobs?.().catch(() => undefined);

    if (task.grading === "patch") {
      patch = await extractPatch(sandbox, headRef, baselineUntracked).catch((error: unknown) => {
        failure ??= `patch extraction failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        return "";
      });
      // The locked protocol grades a pristine container, never the agent's.
      await sandbox.destroy().catch(() => undefined);
      sandbox = undefined;

      verifierSandbox = createTaskSandbox(task, options, true);
      await verifierSandbox.start();
      if (patch.trim()) {
        await applyPatch(verifierSandbox, patch).catch((error: unknown) => {
          failure ??= `agent patch failed to apply: ${
            error instanceof Error ? error.message : String(error)
          }`;
        });
      } else {
        failure ??= "agent produced an empty patch";
      }
      verifier = await runVerifier(verifierSandbox, task);
    } else {
      // Terminal-Bench: the verifier inspects this container's final state.
      const maybePatch = await sandbox
        .exec("git diff HEAD --binary -- . ':(exclude).anchor'", {
          timeoutSecs: 120,
          concurrent: true,
        })
        .catch(() => undefined);
      if (maybePatch?.exitCode === 0) patch = maybePatch.stdout;
      verifier = await runVerifier(sandbox, task);
    }

    const checks = [
      {
        id: "task-verifier",
        ok: verifier.reward >= 0.95,
        exitCode: verifier.exitCode,
        output: verifier.output,
        weight: 1,
      },
    ];
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
      reward: verifier.reward,
      checks,
      ...(outcome.reason === "finished" && verifier.reward < 0.95
        ? { falseFinish: true }
        : {}),
      wallMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
    if (verifierSandbox) await verifierSandbox.destroy().catch(() => {});
    if (sandbox) await sandbox.destroy().catch(() => {});
  }

  return result;
}
