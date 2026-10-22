/**
 * The progress ledger — durable task state that survives phases, compaction,
 * and resume. It is deliberately storage-agnostic: the engine carries it in
 * the existing thread record; consumers do not wire a new store.
 *
 * Requirements are append-only commitments. Tool results are evidence
 * references; raw output stays in the thread/artifact store. The ledger is
 * rendered into the prompt as a compact view; the full object feeds the gate
 * and the verifier.
 */

export type RequirementStatus =
  | "open"
  | "in_progress"
  | "verified"
  | "blocked"
  | "waived"
  | "superseded";

export interface LedgerSource {
  kind: "user" | "system" | "compiled";
  /** The authoritative task text. Immutable for the ledger's lifetime. */
  text: string;
  /** Optional content hash so a revision can prove the source changed. */
  hash?: string;
}

export interface LedgerRequirement {
  id: string;
  text: string;
  /** Required for completion; optional items never block the gate. */
  required: boolean;
  status: RequirementStatus;
  evidenceIds: string[];
  /** User/source requirements are locked; agents may add, never delete. */
  locked: boolean;
  origin: "user" | "compiled" | "agent";
  /** Quote from the source that grounds this requirement, when user-stated. */
  sourceQuote?: string;
  /** Set when the requirement is superseded by a later revision. */
  supersededBy?: string;
  /** Ledger revision that created/last changed this requirement. */
  revision: number;
}

export interface LedgerEvidenceRef {
  id: string;
  /** Tool name, e.g. bash, edit_file, mcp__github__search. */
  tool: string;
  /** Pointer to the raw result: message id, artifact path, or URL. */
  ref: string;
  ok: boolean;
  capturedAt: string;
  /** Short, human-readable summary; never the full output. */
  summary?: string;
  meta?: Record<string, unknown>;
}

export interface ProgressLedger {
  version: 1;
  taskId: string;
  revision: number;
  source: LedgerSource;
  goal: string;
  requirements: LedgerRequirement[];
  evidence: Record<string, LedgerEvidenceRef>;
  openFailures: string[];
  nextStep?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLedgerInput {
  taskId: string;
  source: string | LedgerSource;
  goal?: string;
  requirements?: Array<{
    text: string;
    required?: boolean;
    origin?: LedgerRequirement["origin"];
    sourceQuote?: string;
  }>;
  now?: string;
}

export interface LedgerRevisionInput {
  reason: string;
  nextStep?: string;
  supersede?: string[];
  add?: Array<{
    text: string;
    required?: boolean;
    sourceQuote?: string;
  }>;
  now?: string;
}

export interface LedgerGatePolicy {
  /** Waived requirements satisfy the gate when true. */
  allowWaived?: boolean;
  /** Ignore non-empty openFailures when true (for reporting only). */
  ignoreOpenFailures?: boolean;
}

export interface LedgerGateResult {
  allow: boolean;
  open: string[];
  missingEvidence: string[];
  failures: string[];
  superseded: string[];
}
