/**
 * Phase-alignment verifier — a cheap structured judgment at phase boundaries.
 *
 * It does not decide whether the agent can finish (the ledger/finish gate does
 * that). It answers a narrower question: does the active ledger serve the
 * current phase, and if not, is the divergence justified by the task or a
 * user revision?
 */
import { completeStructured } from "../llm/structured.js";
import type { LLMClient, LLMRequest, LLMUsage } from "../llm/types.js";
import { renderLedger } from "./ledger.js";
import type { PhaseGoal } from "./compiler.js";
import type { ProgressLedger } from "./types.js";

export type AlignmentAction =
  | "none"
  | "update_ledger"
  | "change_phase"
  | "gather_evidence";

export interface AlignmentVerdict {
  allow: boolean;
  aligned: boolean;
  justified: boolean;
  reason: string;
  requiredAction: AlignmentAction;
  confidence: number;
}

export interface VerifyAlignmentOptions {
  llm: LLMClient;
  request: string;
  phase: PhaseGoal;
  ledger: ProgressLedger;
  /** Compact recent evidence lines; full evidence is not needed. */
  recentEvidence?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: LLMRequest["reasoningEffort"];
  signal?: AbortSignal;
}

export interface VerifyAlignmentResult {
  verdict: AlignmentVerdict;
  usage?: LLMUsage;
}

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    allow: { type: "boolean" },
    aligned: { type: "boolean" },
    justified: { type: "boolean" },
    reason: { type: "string" },
    requiredAction: {
      type: "string",
      enum: ["none", "update_ledger", "change_phase", "gather_evidence"],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "allow",
    "aligned",
    "justified",
    "reason",
    "requiredAction",
    "confidence",
  ],
  additionalProperties: false,
};

function parseVerdict(value: unknown): AlignmentVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("verifier output must be an object");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.allow !== "boolean" ||
    typeof row.aligned !== "boolean" ||
    typeof row.justified !== "boolean"
  ) {
    throw new Error("verifier output needs boolean allow/aligned/justified");
  }
  if (typeof row.reason !== "string" || row.reason.trim() === "") {
    throw new Error("verifier output needs a reason");
  }
  const actions: AlignmentAction[] = [
    "none",
    "update_ledger",
    "change_phase",
    "gather_evidence",
  ];
  if (!actions.includes(row.requiredAction as AlignmentAction)) {
    throw new Error("verifier output has an invalid requiredAction");
  }
  if (
    typeof row.confidence !== "number" ||
    row.confidence < 0 ||
    row.confidence > 1
  ) {
    throw new Error("verifier output has an invalid confidence");
  }
  return {
    allow: row.allow,
    aligned: row.aligned,
    justified: row.justified,
    reason: row.reason.trim(),
    requiredAction: row.requiredAction as AlignmentAction,
    confidence: row.confidence,
  };
}

export async function verifyAlignment(
  opts: VerifyAlignmentOptions,
): Promise<VerifyAlignmentResult> {
  const ledger = renderLedger(opts.ledger, {
    includeSource: false,
    includeEvidence: false,
  });
  const result = await completeStructured(opts.llm, {
    name: "phase_alignment",
    schema: SCHEMA,
    parse: parseVerdict,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
    ...(opts.reasoningEffort !== undefined
      ? { reasoningEffort: opts.reasoningEffort }
      : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    messages: [
      {
        role: "system",
        content: [
          "You are a strict but practical phase-alignment verifier.",
          "The phase goal is a high-level direction. The ledger goals are concrete commitments.",
          "Decide whether the active ledger work serves the current phase.",
          "Do not require literal string matches. A broad ledger goal can serve an early phase; a late phase needs evidence or a concrete goal for that phase.",
          "If the work does not align, allow only when the divergence is justified by the task or by a user direction change.",
          "If evidence is absent for the phase's required work, set allow=false and requiredAction=gather_evidence.",
          "Return only the structured verdict.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `REQUEST:\n${opts.request}`,
          `PHASE:\n- ${opts.phase.id}: ${opts.phase.goal}${opts.phase.guidance ? ` ${opts.phase.guidance}` : ""}`,
          `LEDGER:\n${ledger}`,
          `RECENT EVIDENCE:\n${opts.recentEvidence ?? "(none)"}`,
        ].join("\n\n"),
      },
    ],
  });

  return {
    verdict: result.value,
    ...(result.response.usage ? { usage: result.response.usage } : {}),
  };
}
