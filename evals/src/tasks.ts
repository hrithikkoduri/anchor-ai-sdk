/**
 * Benchmark tasks: the normalized shape every arm receives.
 *
 * Two row shapes share one runner:
 *
 *   - SWE-bench rows: repo + base commit (or a prebuilt image), graded by the
 *     official harness outside this process.
 *   - Harness rows: a local fixture directory plus weighted checks that run in
 *     the sandbox after the arm finishes. This is the dense-reward path: an
 *     incomplete run still reports how far it got.
 *
 * FAIL_TO_PASS / PASS_TO_PASS are carried for the report — arms must never
 * read them. A harness row's checks are the task's public contract; they are
 * visible to the grader, not injected into the prompt.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

/** One independently scored behavior in a local harness task. */
export interface EvalCheck {
  id: string;
  /** Command run in the sandbox workspace. Exit 0 = pass. */
  command: string;
  /** Relative weight; defaults to 1. */
  weight?: number;
  timeoutSecs?: number;
}

export interface EvalBudgets {
  maxSteps?: number;
  maxTokens?: number;
  maxUsd?: number;
}

export interface EvalTask {
  /** `instance_id` for SWE-bench; the fixture id for harness tasks. */
  id: string;
  /**
   * `harbor` tasks are the Harbor task-directory format used by SWE-bench Pro
   * V2 and Terminal-Bench 2.1: task.toml + instruction.md + tests/. They are
   * graded by the task's own verifier, not by a patch-to-SWE-bench adapter.
   */
  kind?: "harbor";
  /** Host directory holding the task's verifier (`tests/`), Harbor only. */
  testsDir?: string;
  /** Verifier wall-clock ceiling from task.toml, Harbor only. */
  verifierTimeoutSecs?: number;
  /**
   * `patch`: grade a captured git patch in a pristine container (SWE-bench
   * Pro's locked protocol). `in-place`: run the verifier in the agent's
   * container (Terminal-Bench's state-based tasks).
   */
  grading?: "patch" | "in-place";
  /** Cut the agent sandbox's network (Harbor `agent.network_mode`). */
  agentEgress?: "none";
  /** Cloneable git URL (a bare `owner/name` becomes a GitHub https URL). */
  repoUrl?: string;
  /** The commit the task starts from. */
  baseRef?: string;
  /** A host directory copied into the sandbox (local backend only). */
  localPath?: string;
  /** The issue text the agent works from. */
  problem: string;
  /** Dense checks for a local harness task. Absent for SWE-bench. */
  checks?: EvalCheck[];
  /**
   * SWE-bench's official test patch. The runner extracts the agent's patch
   * first, then applies this to the workspace before running checks — the same
   * order the official grader uses. Never shown to the agent.
   */
  testPatch?: string;
  /**
   * Commands run once after the sandbox starts (and after a fixture upload),
   * before the arm. A clone-based run uses this to install the project's
   * dependencies; an image-backed run usually leaves it empty.
   */
  setup?: string[];
  /** Wall-clock ceiling for the arm; checks still run after a timeout. */
  timeBudgetSecs?: number;
  /** Per-task budget overrides. */
  budgets?: EvalBudgets;
  /** Tests that must flip from failing to passing (reporting only). */
  failToPass?: string[];
  /** Tests that must not regress (reporting only). */
  passToPass?: string[];
  /**
   * A pre-built image whose workspace ALREADY exists with the repo checked
   * out and dependencies installed (SWE-bench task images). When present, the
   * runner boots this image instead of cloning `repoUrl`.
   */
  image?: string;
  /** Where the pre-existing workspace lives inside the image. */
  workspacePath?: string;
  /**
   * Extra sandbox env for this task. Swebench images ship BASH_ENV to activate
   * the testbed conda env (their own runner config does this) — without it,
   * every command runs in the base env and the agent re-installs dependencies.
   */
  env?: Record<string, string>;
}

function listFrom(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function checksFrom(value: unknown): EvalCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`check ${index} must be an object`);
    }
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? "");
    const command = String(row.command ?? "");
    if (!id || !command) {
      throw new Error(`check ${index} needs an id and a command`);
    }
    const weight = row.weight === undefined ? undefined : Number(row.weight);
    if (weight !== undefined && (!Number.isFinite(weight) || weight < 0)) {
      throw new Error(`check "${id}" has an invalid weight`);
    }
    const timeoutSecs =
      row.timeoutSecs === undefined ? undefined : Number(row.timeoutSecs);
    return {
      id,
      command,
      ...(weight !== undefined ? { weight } : {}),
      ...(timeoutSecs !== undefined ? { timeoutSecs } : {}),
    };
  });
}

function budgetsFrom(value: unknown): EvalBudgets | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const out: EvalBudgets = {};
  for (const key of ["maxSteps", "maxTokens", "maxUsd"] as const) {
    const number = Number(row[key]);
    if (row[key] !== undefined && Number.isFinite(number)) out[key] = number;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A SWE-bench-shaped row. */
export function taskFromRow(row: Record<string, unknown>): EvalTask {
  const id = String(row.instance_id ?? "");
  const repo = String(row.repo ?? "");
  const baseRef = String(row.base_commit ?? "");
  const problem = String(row.problem_statement ?? "");
  const image = row.image ? String(row.image) : undefined;
  if (!id || !problem) {
    throw new Error(`task row missing a required field (${id || "no id"})`);
  }
  if (!(repo && baseRef) && !image) {
    throw new Error(`task ${id} needs repoUrl+baseRef or an image`);
  }
  const failToPass = listFrom(row.FAIL_TO_PASS);
  const passToPass = listFrom(row.PASS_TO_PASS);
  const setup = Array.isArray(row.setup)
    ? row.setup.map(String).filter((command) => command.trim() !== "")
    : undefined;
  const testPatch =
    typeof row.test_patch === "string" ? row.test_patch : undefined;
  return {
    id,
    ...(repo
      ? {
          repoUrl: /^https?:\/\//.test(repo)
            ? repo
            : `https://github.com/${repo}.git`,
        }
      : {}),
    ...(baseRef ? { baseRef } : {}),
    problem,
    ...(failToPass ? { failToPass } : {}),
    ...(passToPass ? { passToPass } : {}),
    ...(setup && setup.length > 0 ? { setup } : {}),
    ...(testPatch ? { testPatch } : {}),
    // SWE-bench task images carry the repo at /testbed, fully provisioned.
    ...(image
      ? {
          image,
          workspacePath: "/testbed",
          // PYTHONPATH: the repo at /testbed is NOT installed editable in these
          // images — `site-packages/<pkg>` is a separate, stale copy (verified
          // against psf__requests-1963: a /tmp script imported the installed
          // 2.3.0 package while /testbed held the agent's edits). `python -c`
          // sees the repo because the cwd is sys.path[0], but a script
          // elsewhere does not, so the agent reads its own edits as having no
          // effect. PYTHONPATH is searched before site-packages: the repo wins
          // from any directory. Grading is unaffected — the official harness
          // boots its own container and never reads this env.
          env: { BASH_ENV: "/root/.bashrc", PYTHONPATH: "/testbed" },
        }
      : {}),
  };
}

/**
 * A local harness row: `path` is a fixture directory relative to this JSONL,
 * `checks` are weighted commands. No repo clone, no image, no external grader.
 */
export function taskFromHarnessRow(
  row: Record<string, unknown>,
  baseDir: string,
): EvalTask {
  const id = String(row.id ?? "");
  const fixture = String(row.path ?? "");
  const problem = String(row.problem ?? "");
  if (!id || !fixture || !problem) {
    throw new Error(`harness task missing id, path, or problem (${id || "no id"})`);
  }
  const checks = checksFrom(row.checks);
  if (!checks || checks.length === 0) {
    throw new Error(`harness task ${id} needs at least one check`);
  }
  const localPath = path.isAbsolute(fixture)
    ? fixture
    : path.resolve(baseDir, fixture);
  const timeBudgetSecs =
    row.timeBudgetSecs === undefined ? undefined : Number(row.timeBudgetSecs);
  const budgets = budgetsFrom(row.budgets);
  const setup = Array.isArray(row.setup)
    ? row.setup.map(String).filter((command) => command.trim() !== "")
    : undefined;
  return {
    id,
    localPath,
    problem,
    checks,
    ...(setup && setup.length > 0 ? { setup } : {}),
    ...(timeBudgetSecs !== undefined && Number.isFinite(timeBudgetSecs)
      ? { timeBudgetSecs }
      : {}),
    ...(budgets ? { budgets } : {}),
  };
}

/**
 * A Harbor task row points at a task directory. `task.toml` is the source of
 * truth for the image and timeouts; the row may override them for a shard.
 */
async function harborTaskFromRow(
  row: Record<string, unknown>,
  baseDir: string,
): Promise<EvalTask> {
  const taskPath = String(row.path ?? "");
  const id = String(row.id ?? taskPath);
  if (!taskPath) throw new Error("harbor task row needs a path");
  const dir = path.isAbsolute(taskPath)
    ? taskPath
    : path.resolve(baseDir, taskPath);
  const toml = parseToml(await readFile(path.join(dir, "task.toml"), "utf8")) as {
    task?: { name?: string };
    environment?: {
      docker_image?: string;
      env?: Record<string, unknown>;
    };
    agent?: { timeout_sec?: number; network_mode?: string };
    verifier?: { timeout_sec?: number };
  };
  const image = String(row.image ?? toml.environment?.docker_image ?? "");
  if (!image) throw new Error(`harbor task ${id} has no docker_image`);
  const problem = await readFile(path.join(dir, "instruction.md"), "utf8");
  const agentTimeout = Number(
    row.timeBudgetSecs ?? toml.agent?.timeout_sec ?? 900,
  );
  const verifierTimeout = Number(
    row.verifierTimeoutSecs ?? toml.verifier?.timeout_sec ?? 900,
  );
  const grading = row.grading === "in-place" ? "in-place" : "patch";
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(toml.environment?.env ?? {})) {
    if (typeof value === "string" || typeof value === "number") {
      env[key] = String(value);
    }
  }
  // SWE-bench Pro's verifier already applies the test patch and reads the
  // fail-to-pass/pass-to-pass lists; the IDs are for the report, not the arm.
  let failToPass: string[] | undefined;
  let passToPass: string[] | undefined;
  try {
    const config = JSON.parse(
      await readFile(path.join(dir, "tests", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    const parseList = (value: unknown): string[] | undefined => {
      if (Array.isArray(value)) return value.map(String);
      if (typeof value === "string") {
        try {
          const parsed: unknown = JSON.parse(value);
          return Array.isArray(parsed) ? parsed.map(String) : undefined;
        } catch {
          return undefined;
        }
      }
      return undefined;
    };
    failToPass = parseList(config.fail_to_pass) ?? parseList(config.FAIL_TO_PASS);
    passToPass = parseList(config.pass_to_pass) ?? parseList(config.PASS_TO_PASS);
  } catch {
    // A task without a public config is still runnable; the verifier owns it.
  }
  return {
    id,
    kind: "harbor",
    problem,
    image,
    workspacePath: String(row.workspacePath ?? "/app"),
    testsDir: path.join(dir, "tests"),
    verifierTimeoutSecs:
      Number.isFinite(verifierTimeout) && verifierTimeout > 0
        ? verifierTimeout
        : 900,
    grading,
    ...(toml.agent?.network_mode === "no-network"
      ? { agentEgress: "none" }
      : {}),
    timeBudgetSecs:
      Number.isFinite(agentTimeout) && agentTimeout > 0
        ? agentTimeout
        : 900,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(failToPass ? { failToPass } : {}),
    ...(passToPass ? { passToPass } : {}),
  };
}

export async function loadTasks(file: string): Promise<EvalTask[]> {
  const text = await readFile(file, "utf8");
  const baseDir = path.dirname(path.resolve(file));
  const rows = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return Promise.all(
    rows.map((row) =>
      row.kind === "harbor"
        ? harborTaskFromRow(row, baseDir)
        : row.path !== undefined || row.checks !== undefined
          ? Promise.resolve(taskFromHarnessRow(row, baseDir))
          : Promise.resolve(taskFromRow(row)),
    ),
  );
}
