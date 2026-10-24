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

type RequirementDraft = {
  id?: string;
  text: string;
  required?: boolean;
  origin?: LedgerRequirement["origin"];
  sourceQuote?: string;
  phase?: string;
  dependsOn?: string[];
};

const REQUIREMENT_ID = /^[a-z][a-z0-9_-]{0,31}$/;

function generatedRequirementId(used: ReadonlySet<string>): string {
  let max = 0;
  for (const id of used) {
    const match = /^r(\d+)$/.exec(id);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) max = Math.max(max, value);
  }
  let n = max + 1;
  while (used.has(`r${n}`)) n += 1;
  return `r${n}`;
}

function dependencyIds(value: string[] | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const raw of value) {
    const id = raw.trim();
    if (!id) throw new Error("requirement dependency id must not be empty");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Validate ids, references, superseded edges, and cycles. Exported for tests. */
export function validateRequirementGraph(
  requirements: readonly LedgerRequirement[],
): void {
  const byId = new Map<string, LedgerRequirement>();
  for (const requirement of requirements) {
    if (!REQUIREMENT_ID.test(requirement.id)) {
      throw new Error(
        `invalid requirement id "${requirement.id}"; expected ^[a-z][a-z0-9_-]{0,31}$`,
      );
    }
    if (byId.has(requirement.id)) {
      throw new Error(`duplicate requirement id "${requirement.id}"`);
    }
    byId.set(requirement.id, requirement);
  }
  for (const requirement of requirements) {
    // Superseded nodes are historical. Their edges no longer constrain the
    // active contract, so do not reject a revision that supersedes both ends.
    if (requirement.status === "superseded") continue;
    for (const dependency of requirement.dependsOn ?? []) {
      if (dependency === requirement.id) {
        throw new Error(`requirement ${requirement.id} cannot depend on itself`);
      }
      const target = byId.get(dependency);
      if (!target) {
        throw new Error(
          `requirement ${requirement.id} depends on unknown requirement "${dependency}"`,
        );
      }
      if (target.status === "superseded") {
        throw new Error(
          `requirement ${requirement.id} depends on superseded requirement "${dependency}"; depend on its replacement instead`,
        );
      }
    }
  }
  const active = requirements.filter((item) => item.status !== "superseded");
  const activeById = new Map(active.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const cycleAt = path.indexOf(id);
    if (visiting.has(id) || cycleAt !== -1) {
      const cycle = [...path.slice(cycleAt === -1 ? 0 : cycleAt), id];
      throw new Error(`requirement dependency cycle: ${cycle.join(" → ")}`);
    }
    visiting.add(id);
    path.push(id);
    const requirement = activeById.get(id);
    for (const dependency of requirement?.dependsOn ?? []) {
      visit(dependency);
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const requirement of active) visit(requirement.id);
}

function buildRequirements(
  existing: readonly LedgerRequirement[],
  drafts: readonly RequirementDraft[],
  defaultOrigin: LedgerRequirement["origin"],
  revision: number,
): LedgerRequirement[] {
  const used = new Set(existing.map((item) => item.id));
  // Reserve explicit ids first so generated ids cannot collide with a later id.
  const explicit = new Set<string>();
  for (const draft of drafts) {
    if (draft.id === undefined) continue;
    const id = draft.id.trim();
    if (!REQUIREMENT_ID.test(id)) {
      throw new Error(
        `invalid requirement id "${draft.id}"; expected ^[a-z][a-z0-9_-]{0,31}$`,
      );
    }
    if (explicit.has(id) || used.has(id)) {
      throw new Error(`duplicate requirement id "${id}"`);
    }
    explicit.add(id);
    used.add(id);
  }
  const created = drafts.map((draft): LedgerRequirement => {
    const text = draft.text.trim();
    if (!text) throw new Error("ledger requirement text must not be empty");
    const id = draft.id?.trim() || generatedRequirementId(used);
    used.add(id);
    const dependsOn = dependencyIds(draft.dependsOn);
    return {
      id,
      text,
      required: draft.required ?? true,
      ...(draft.phase ? { phase: draft.phase } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      status: "open",
      evidenceIds: [],
      locked: (draft.origin ?? defaultOrigin) !== "agent",
      origin: draft.origin ?? defaultOrigin,
      ...(draft.sourceQuote ? { sourceQuote: draft.sourceQuote } : {}),
      revision,
    };
  });
  validateRequirementGraph([...existing, ...created]);
  return created;
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
  ledger.requirements = buildRequirements(
    [],
    input.requirements ?? [],
    "user",
    1,
  );
  return ledger;
}

export function addRequirement(
  ledger: ProgressLedger,
  input: RequirementDraft,
  origin: LedgerRequirement["origin"] = "agent",
): LedgerRequirement {
  const [requirement] = buildRequirements(
    ledger.requirements,
    [{ ...input, origin }],
    origin,
    ledger.revision,
  );
  ledger.requirements.push(requirement!);
  ledger.updatedAt = nowIso();
  return requirement!;
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
  claim: string,
): void {
  const requirement = findRequirement(ledger, requirementId);
  const evidence = ledger.evidence[evidenceId];
  if (!evidence) throw new Error(`unknown evidence id "${evidenceId}"`);
  const text = claim.trim();
  if (!text || text.length > 400) {
    throw new Error("claim must be 1-400 characters");
  }
  evidence.claim = text;
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
  const next: ProgressLedger = {
    ...ledger,
    revision: ledger.revision + 1,
    requirements: ledger.requirements.map((requirement) => ({
      ...requirement,
      evidenceIds: [...requirement.evidenceIds],
      ...(requirement.dependsOn
        ? { dependsOn: [...requirement.dependsOn] }
        : {}),
    })),
    openFailures: [...ledger.openFailures],
    evidence: { ...ledger.evidence },
  };
  for (const id of change.supersede ?? []) {
    const requirement = findRequirement(next, id);
    requirement.status = "superseded";
    requirement.supersededBy = `revision ${next.revision}`;
  }
  const created = buildRequirements(
    next.requirements,
    change.add ?? [],
    "user",
    next.revision,
  );
  next.requirements.push(...created);
  validateRequirementGraph(next.requirements);
  if (change.nextStep !== undefined) next.nextStep = change.nextStep;
  next.updatedAt = nowIso(change.now);
  Object.assign(ledger, next);
  return ledger;
}

/**
 * Dependencies that are not settled for a requirement. `allowWaived` controls
 * whether a waived dependency satisfies its dependents.
 */
export function unmetDependencies(
  ledger: ProgressLedger,
  requirement: LedgerRequirement,
  policy: LedgerGatePolicy = {},
): string[] {
  const byId = new Map(ledger.requirements.map((item) => [item.id, item]));
  return (requirement.dependsOn ?? []).filter((id) => {
    const dependency = byId.get(id);
    if (!dependency) return true;
    if (dependency.status === "verified") return false;
    if (policy.allowWaived && dependency.status === "waived") return false;
    return true;
  });
}

/** Requirements whose required dependencies are already settled. */
export function readyRequirements(
  ledger: ProgressLedger,
  policy: LedgerGatePolicy = {},
): string[] {
  return ledger.requirements
    .filter(
      (requirement) =>
        (requirement.status === "open" ||
          requirement.status === "in_progress") &&
        unmetDependencies(ledger, requirement, policy).length === 0,
    )
    .map((requirement) => requirement.id);
}

/** Deterministic coverage gate. This is not a quality judgment. */
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
  const unsatisfiedDependencies = active.flatMap((requirement) => {
    if (!requirement.required) return [];
    return unmetDependencies(ledger, requirement, policy).map(
      (dependency) => `${requirement.id} requires ${dependency}`,
    );
  });
  const failures = policy.ignoreOpenFailures ? [] : [...ledger.openFailures];
  return {
    allow:
      blocking.length === 0 &&
      missingEvidence.length === 0 &&
      unsatisfiedDependencies.length === 0 &&
      failures.length === 0,
    open: blocking.map((item) => item.id),
    missingEvidence,
    failures,
    superseded: ledger.requirements
      .filter((item) => item.status === "superseded")
      .map((item) => item.id),
    unsatisfiedDependencies,
  };
}

/** Stable topological order for the active requirement graph. */
export function topologicalRequirements(
  requirements: readonly LedgerRequirement[],
): LedgerRequirement[] {
  const active = requirements.filter((item) => item.status !== "superseded");
  const byId = new Map(active.map((item) => [item.id, item]));
  const index = new Map(active.map((item, i) => [item.id, i]));
  const indegree = new Map(
    active.map((item) => [
      item.id,
      (item.dependsOn ?? []).filter((id) => byId.has(id)).length,
    ]),
  );
  const dependents = new Map<string, string[]>();
  for (const item of active) {
    for (const dependency of item.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const list = dependents.get(dependency) ?? [];
      list.push(item.id);
      dependents.set(dependency, list);
    }
  }
  const ready = active
    .filter((item) => (indegree.get(item.id) ?? 0) === 0)
    .map((item) => item.id);
  const out: LedgerRequirement[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  return out.length === active.length ? out : active;
}

export interface RenderLedgerOptions {
  /** Include the immutable source text. Default true. */
  includeSource?: boolean;
  /** Include evidence lines. Default true. */
  includeEvidence?: boolean;
  /** Whether waived dependencies satisfy dependents in the READY set. */
  allowWaived?: boolean;
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
  const active = topologicalRequirements(ledger.requirements);
  const ready = readyRequirements(ledger, { allowWaived: opts.allowWaived });
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
    const after = item.dependsOn?.length
      ? ` after ${item.dependsOn.join(", ")}`
      : "";
    lines.push(
      `- ${item.id} [${item.status}]${item.phase ? ` phase=${item.phase}` : ""}${item.required ? "" : " optional"} ${item.text}${after}`,
    );
  }
  lines.push("", `READY: ${ready.length ? ready.join(", ") : "(none)"}`);
  if (includeEvidence) {
    lines.push("", "EVIDENCE:");
    const refs = Object.values(ledger.evidence);
    if (refs.length === 0) lines.push("- (none yet)");
    for (const evidence of refs) {
      lines.push(
        `- ${evidence.id} ${evidence.tool}${evidence.claim ? ` claim=${evidence.claim}` : ""}${evidence.summary ? `: ${evidence.summary}` : ""}${evidence.ok ? "" : " (failed)"}`,
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
