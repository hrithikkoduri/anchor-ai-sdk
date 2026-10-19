/**
 * Benchmark tasks: the normalized shape every arm receives.
 *
 * SWE-bench rows carry far more than this (gold patches, environment setup);
 * the runner deliberately keeps only the fields an arm may see. FAIL_TO_PASS /
 * PASS_TO_PASS are carried for the report — arms must never read them.
 */
import { readFile } from "node:fs/promises";

export interface EvalTask {
  /** `instance_id` — the grader's join key. */
  id: string;
  /** Cloneable git URL (a bare `owner/name` becomes a GitHub https URL). */
  repoUrl: string;
  /** The commit the task starts from. */
  baseRef: string;
  /** The issue text the agent works from. */
  problem: string;
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

export function taskFromRow(row: Record<string, unknown>): EvalTask {
  const id = String(row.instance_id ?? "");
  const repo = String(row.repo ?? "");
  const baseRef = String(row.base_commit ?? "");
  const problem = String(row.problem_statement ?? "");
  if (!id || !repo || !baseRef || !problem) {
    throw new Error(`task row missing a required field (${id || "no id"})`);
  }
  const failToPass = listFrom(row.FAIL_TO_PASS);
  const passToPass = listFrom(row.PASS_TO_PASS);
  const image = row.image ? String(row.image) : undefined;
  return {
    id,
    repoUrl: /^https?:\/\//.test(repo)
      ? repo
      : `https://github.com/${repo}.git`,
    baseRef,
    problem,
    ...(failToPass ? { failToPass } : {}),
    ...(passToPass ? { passToPass } : {}),
    // SWE-bench task images carry the repo at /testbed, fully provisioned.
    ...(image
      ? {
          image,
          workspacePath: "/testbed",
          env: { BASH_ENV: "/root/.bashrc" },
        }
      : {}),
  };
}

export async function loadTasks(file: string): Promise<EvalTask[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => taskFromRow(JSON.parse(line) as Record<string, unknown>));
}
