/**
 * Workflow contracts — the engine half of a headless run.
 *
 * A workflow agent (agents/workflow) never talks to a user. Its bundle carries
 * a `WorkflowContract`, and the loop enforces it with the seams it already
 * has: the finish tool's pre-completion gate, the budget check at each turn
 * boundary, and the guardrail knobs. Nothing here runs a second loop.
 *
 * The check-evidence rule lives here as a pure function over the ordered tool
 * results the engine itself recorded, so it never trusts what the model says
 * it ran.
 */
import type { OutputSchema, JSONSchema } from "../schema.js";
import type { ToolResultRecord } from "./strategy.js";

export interface WorkflowContract {
  /** The proof the run must produce before it may finish. */
  check: { command: string; description: string };
  /** The structured result `finish` must carry; validated by the engine. */
  output?: {
    name: string;
    schema: OutputSchema;
    /** JSON schema shown to the model when `schema` is zod without `toJSONSchema`. */
    jsonSchema?: JSONSchema;
    description?: string;
  };
}

/** What the engine observed about the check in this run. */
export type CheckEvidence =
  | { status: "passed"; command: string }
  | { status: "missing" }
  | { status: "running"; command: string }
  | {
      status: "failed";
      command: string;
      exitCode?: number;
      timedOut?: boolean;
    }
  | { status: "stale"; command: string; changedBy: string };

const collapse = (text: string): string => text.trim().replace(/\s+/g, " ");

/**
 * Does `command` run `check` such that the command's exit status IS the
 * check's exit status? The check must be the final element, verbatim
 * (whitespace-normalised), optionally after a prefix that ends in `&&`, `;`,
 * or a newline (`cd app && <check>`), and optionally followed by `2>&1`.
 * Everything else is refused: a pipe or `|| true` after it masks its status,
 * `echo <check>` does not run it, and `true || <check>` skips it.
 */
export function invokesCheck(command: string, check: string): boolean {
  const wanted = collapse(check);
  if (!wanted) return false;
  // Newlines are separators; keep them distinguishable from spaces.
  const normalized = command
    .split("\n")
    .map(collapse)
    .filter(Boolean)
    .join(" ; ");
  const at = normalized.lastIndexOf(wanted);
  if (at < 0) return false;
  const prefix = normalized.slice(0, at).trimEnd();
  const suffix = normalized.slice(at + wanted.length).trim();
  if (suffix !== "" && suffix !== "2>&1") return false;
  if (prefix === "") return true;
  if (!prefix.endsWith("&&") && !prefix.endsWith(";")) return false;
  return !REWRITES_STATUS.test(prefix);
}

/**
 * Prefix constructs that can end the shell before the check, or replace what
 * the check's name means: `exit 0;`, `trap 'exit 0' EXIT;`, `exec true;`,
 * `npm() { :; };`. This is honest-path enforcement, not a security boundary.
 */
const REWRITES_STATUS = /\b(exit|trap|return|exec|alias|function|unset)\b|\(\s*\)/;

/** A successful tool result that changed files the check ran against. */
function changedFiles(record: ToolResultRecord): string | undefined {
  if (!record.ok && record.tool !== "batch") return undefined;
  if (record.tool === "edit_file") return "edit_file";
  if (record.tool === "batch") {
    const ops = record.meta?.ops;
    if (
      Array.isArray(ops) &&
      ops.some(
        (op) =>
          typeof op === "object" &&
          op !== null &&
          ((op as { op?: unknown }).op === "edit" ||
            (op as { op?: unknown }).op === "write") &&
          (op as { status?: unknown }).status === "ok",
      )
    )
      return "batch";
  }
  return undefined;
}

/**
 * The latest run of the check in this run's own tool log, and whether it still
 * stands. Only `bash` results count, and only their engine-recorded `meta`
 * (`command`, `exitCode`, `timedOut`) — the command the tool actually ran and
 * the status the sandbox actually reported. A pass is withdrawn by a later
 * failing run of the check, or by a later successful file edit.
 */
export function checkEvidence(
  log: readonly ToolResultRecord[],
  check: string,
): CheckEvidence {
  let latest: { index: number; record: ToolResultRecord; command: string } | undefined;
  log.forEach((record, index) => {
    const command = record.meta?.command;
    if (
      record.tool === "bash" &&
      typeof command === "string" &&
      invokesCheck(command, check)
    )
      latest = { index, record, command };
  });
  if (!latest) return { status: "missing" };
  const { record, command } = latest;
  const meta = record.meta ?? {};
  if (meta.background !== undefined) return { status: "running", command };
  const exitCode = typeof meta.exitCode === "number" ? meta.exitCode : undefined;
  const timedOut = meta.timedOut === true;
  if (!record.ok || exitCode !== 0 || timedOut)
    return {
      status: "failed",
      command,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(timedOut ? { timedOut } : {}),
    };
  for (const later of log.slice(latest.index + 1)) {
    const changedBy = changedFiles(later);
    if (changedBy) return { status: "stale", command, changedBy };
  }
  return { status: "passed", command };
}

/** The corrective message for a finish the check does not support. */
export function checkRejection(
  contract: WorkflowContract,
  evidence: Exclude<CheckEvidence, { status: "passed" }>,
): string {
  const check = contract.check.command;
  const head = "finish rejected: this workflow may only finish after its check passes in this run.";
  const how = `Run the check with bash exactly as given — \`${check}\` (a \`cd <dir> &&\` prefix is fine) — fix what it reports, and call finish again.`;
  switch (evidence.status) {
    case "missing":
      return `${head}\nThe check (${contract.check.description}) has not been run.\n${how}`;
    case "running":
      return `${head}\nThe latest check run is still in the background; its result is not evidence yet. Wait for it, or run it again in the foreground.`;
    case "failed":
      return (
        `${head}\nThe latest check run failed` +
        (evidence.timedOut
          ? " (timed out)"
          : evidence.exitCode !== undefined
            ? ` (exit ${evidence.exitCode})`
            : "") +
        `: \`${evidence.command}\`.\n${how}`
      );
    case "stale":
      return `${head}\nFiles changed (${evidence.changedBy}) after the check last passed, so that pass no longer describes this workspace.\n${how}`;
  }
}

/** A prose turn in a workflow is never the result. */
export function workflowProseRejection(contract: WorkflowContract): string {
  return (
    "No one reads prose in this run, and a reply does not end it. " +
    "Keep working with tool calls; when the check passes, call `finish`" +
    (contract.output ? ` with \`output\` (${contract.output.name}).` : ".")
  );
}

/** The opening user turn when the caller supplies none: the brief is in the system prompt. */
export const WORKFLOW_KICKOFF =
  "Start the workflow. The brief above is complete; there is nothing more to ask.";
