/**
 * Pure ledger operations: create, append, link evidence, revise, gate, render.
 *
 * No storage and no model calls here. The engine owns persistence (through the
 * existing thread store) and evidence capture; this module owns the contract
 * semantics so every consumer and verifier asks the same questions.
 */
import type {
  CreateLedgerInput,
  LedgerEvidenceRef,
  LedgerGatePolicy,
  LedgerGateResult,
  LedgerRequirement,
  LedgerRevisionInput,
  LedgerSource,
  ProgressLedger,
  RequirementStatus,
} from "./types.js";

const nowIso = (now?: string) => now ?? new Date().toISOString();

function nextId(prefix: "r" | "e", ids: readonly string[]): string {
  let max = 0;
  for (const id of ids) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}${max + 1}`;
}

function sourceOf(input: string | LedgerSource): LedgerSource {
  return typeof input === "string" ? { kind: "user", text: input } : input;
}

export function createLedger(input: CreateLedgerInput): ProgressLedger {
  const at = nowIso(input.now);
  const source = sourceOf(input.source);
  const ledger: ProgressLedger = {
    version: 1,
    taskId: input.taskId,
    revision: 1,
    source,
    goal: input.goal ?? source.text,
    requirements: [],
    evidence: {},
    openFailures: [],
    createdAt: at,
    updatedAt: at,
  };
  for (const requirement of input.requirements ?? []) {
    addRequirement(ledger, requirement, requirement.origin ?? "user");
  }
  return ledger;
}

export function addRequirement(
  ledger: ProgressLedger,
  input: {
    text: string;
    required?: boolean;
    sourceQuote?: string;
  },
  origin: LedgerRequirement["origin"] = "agent",
): LedgerRequirement {
  const text = input.text.trim();
  if (!text) throw new Error("ledger requirement text must not be empty");
  const requirement: LedgerRequirement = {
    id: nextId("r", ledger.requirements.map((item) => item.id)),
    text,
    required: input.required ?? true,
    status: "open",
    evidenceIds: [],
    locked: origin !== "agent",
    origin,
    ...(input.sourceQuote ? { sourceQuote: input.sourceQuote } : {}),
    revision: ledger.revision,
  };
  ledger.requirements.push(requirement);
  ledger.updatedAt = nowIso();
  return requirement;
}

export function recordEvidence(
  ledger: ProgressLedger,
  input: Omit<LedgerEvidenceRef, "id" | "capturedAt"> & { now?: string },
): LedgerEvidenceRef {
  const evidence: LedgerEvidenceRef = {
    id: nextId("e", Object.keys(ledger.evidence)),
    tool: input.tool,
    ref: input.ref,
    ok: input.ok,
    capturedAt: nowIso(input.now),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  };
  ledger.evidence[evidence.id] = evidence;
  ledger.updatedAt = nowIso();
  return evidence;
}

export function linkEvidence(
  ledger: ProgressLedger,
  requirementId: string,
  evidenceId: string,
): void {
  const requirement = findRequirement(ledger, requirementId);
  if (!ledger.evidence[evidenceId]) {
    throw new Error(`unknown evidence id "${evidenceId}"`);
  }
  if (!requirement.evidenceIds.includes(evidenceId)) {
    requirement.evidenceIds.push(evidenceId);
  }
  ledger.updatedAt = nowIso();
}

export function setRequirementStatus(
  ledger: ProgressLedger,
  requirementId: string,
  status: RequirementStatus,
  opts: { supersededBy?: string } = {},
): void {
  const requirement = findRequirement(ledger, requirementId);
  requirement.status = status;
  if (status === "superseded" && opts.supersededBy) {
    requirement.supersededBy = opts.supersededBy;
  }
  ledger.updatedAt = nowIso();
}

export function resolveEvidence(
  ledger: ProgressLedger,
  evidenceId: string,
): LedgerEvidenceRef {
  const evidence = ledger.evidence[evidenceId];
  if (!evidence) throw new Error(`unknown evidence id "${evidenceId}"`);
  return evidence;
}

export function findRequirement(
  ledger: ProgressLedger,
  requirementId: string,
): LedgerRequirement {
  const requirement = ledger.requirements.find(
    (item) => item.id === requirementId,
  );
  if (!requirement) throw new Error(`unknown requirement id "${requirementId}"`);
  return requirement;
}

/**
 * A user-directed revision: old requirements are superseded, never deleted.
 * New requirements are user-locked. The ledger revision advances.
 */
export function reviseLedger(
  ledger: ProgressLedger,
  change: LedgerRevisionInput,
): ProgressLedger {
  ledger.revision += 1;
  for (const id of change.supersede ?? []) {
    const requirement = findRequirement(ledger, id);
    requirement.status = "superseded";
    requirement.supersededBy = `revision ${ledger.revision}`;
  }
  for (const item of change.add ?? []) {
    addRequirement(
      ledger,
      { ...item, required: item.required ?? true },
      "user",
    );
  }
  if (change.nextStep !== undefined) ledger.nextStep = change.nextStep;
  ledger.updatedAt = nowIso(change.now);
  return ledger;
}

/**
 * Deterministic coverage gate. This is not a quality judgment; the verifier
 * adds the semantic check on top.
 */
export function ledgerGate(
  ledger: ProgressLedger,
  policy: LedgerGatePolicy = {},
): LedgerGateResult {
  const active = ledger.requirements.filter(
    (item) => item.status !== "superseded",
  );
  const blocking = active.filter((item) => {
    if (!item.required) return false;
    if (item.status === "verified") return false;
    if (policy.allowWaived && item.status === "waived") return false;
    return true;
  });
  // A requirement cannot be verified without evidence; an agent flipping
  // statuses must not bypass the gate.
  const missingEvidence = ledger.requirements
    .filter(
      (item) =>
        item.required &&
        item.status !== "superseded" &&
        item.evidenceIds.length === 0,
    )
    .map((item) => item.id);
  const failures = policy.ignoreOpenFailures ? [] : [...ledger.openFailures];
  return {
    allow:
      blocking.length === 0 &&
      missingEvidence.length === 0 &&
      failures.length === 0,
    open: blocking.map((item) => item.id),
    missingEvidence,
    failures,
    superseded: ledger.requirements
      .filter((item) => item.status === "superseded")
      .map((item) => item.id),
  };
}

export interface RenderLedgerOptions {
  /** Include the immutable source text. Default true. */
  includeSource?: boolean;
  /** Include evidence lines. Default true. */
  includeEvidence?: boolean;
}

/**
 * Compact prompt view. The model never sees raw evidence IDs alone: evidence
 * is rendered with its summary, and requirements with their text.
 */
export function renderLedger(
  ledger: ProgressLedger,
  opts: RenderLedgerOptions = {},
): string {
  const includeSource = opts.includeSource ?? true;
  const includeEvidence = opts.includeEvidence ?? true;
  const active = ledger.requirements.filter(
    (item) => item.status !== "superseded",
  );
  const lines: string[] = [];
  if (includeSource) {
    lines.push("AUTHORITATIVE TASK:", ledger.source.text, "");
  }
  lines.push(
    `LEDGER — revision ${ledger.revision}`,
    `GOAL: ${ledger.goal}`,
    "",
    "REQUIREMENTS:",
  );
  if (active.length === 0) lines.push("- (none yet)");
  for (const item of active) {
    lines.push(
      `- ${item.id} [${item.status}]${item.required ? "" : " optional"} ${item.text}`,
    );
  }
  if (includeEvidence) {
    lines.push("", "EVIDENCE:");
    const refs = Object.values(ledger.evidence);
    if (refs.length === 0) lines.push("- (none yet)");
    for (const evidence of refs) {
      lines.push(
        `- ${evidence.id} ${evidence.tool}${evidence.summary ? `: ${evidence.summary}` : ""}${evidence.ok ? "" : " (failed)"}`,
      );
    }
  }
  lines.push(
    "",
    "OPEN FAILURES:",
    ...(ledger.openFailures.length ? ledger.openFailures.map((f) => `- ${f}`) : ["- none"]),
    "",
    `NEXT: ${ledger.nextStep ?? "not set"}`,
  );
  return lines.join("\n");
}
