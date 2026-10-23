/**
 * The judge seam. A judge scores the evidence case the agent wrote; it never
 * decides whether to run tools and it never generates the task contract.
 */
import { completeStructured } from "../llm/structured.js";
import type { LLMClient, LLMUsage } from "../llm/types.js";
import { renderLedger } from "../ledger/ledger.js";
import type {
  LedgerEvidenceRef,
  ProgressLedger,
} from "../ledger/types.js";

export interface JudgeCase {
  /** The run's derived request text. */
  request: string;
  phase: { id: string; goal: string; guidance?: string };
  ledger: ProgressLedger;
  /** Evidence captured since this phase began, oldest first. */
  evidenceSincePhase: LedgerEvidenceRef[];
  /** The `reason` the agent passed to set_phase. */
  agentReason?: string;
}

export type JudgeRequirementStatus =
  | "cleared"
  | "insufficient"
  | "unproven";

export interface JudgeVerdict {
  cleared: boolean;
  requirements: Array<{
    id: string;
    status: JudgeRequirementStatus;
    /** Calibrated probability when the judge returns one. */
    probability?: number;
  }>;
  confidence: number;
  /** Prose judges only; typed judges have none. */
  rationale?: string;
  /** Judge model identity + spend, for the trace and the budget. */
  model?: string;
  usage?: LLMUsage;
}

export interface Judge {
  name: string;
  judge(c: JudgeCase, signal?: AbortSignal): Promise<JudgeVerdict>;
}

const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    cleared: { type: "boolean" },
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: {
            type: "string",
            enum: ["cleared", "insufficient", "unproven"],
          },
          probability: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["id", "status"],
        additionalProperties: false,
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string" },
  },
  required: ["cleared", "requirements", "confidence"],
  additionalProperties: false,
};

function parseLlmVerdict(value: unknown): JudgeVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("judge output must be an object");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.cleared !== "boolean" || !Array.isArray(row.requirements)) {
    throw new Error("judge output needs cleared and requirements");
  }
  if (
    typeof row.confidence !== "number" ||
    row.confidence < 0 ||
    row.confidence > 1
  ) {
    throw new Error("judge output has an invalid confidence");
  }
  const statuses = new Set(["cleared", "insufficient", "unproven"]);
  return {
    cleared: row.cleared,
    confidence: row.confidence,
    requirements: row.requirements.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`judge requirement ${index} must be an object`);
      }
      const entry = item as Record<string, unknown>;
      if (
        typeof entry.id !== "string" ||
        !statuses.has(String(entry.status))
      ) {
        throw new Error(`judge requirement ${index} is invalid`);
      }
      return {
        id: entry.id,
        status: entry.status as JudgeRequirementStatus,
        ...(typeof entry.probability === "number"
          ? { probability: entry.probability }
          : {}),
      };
    }),
    ...(typeof row.rationale === "string"
      ? { rationale: row.rationale }
      : {}),
  };
}

/**
 * Prose-compatible judge. This is the old verifier prompt reshaped around
 * per-requirement verdicts instead of one global allow flag.
 */
export function llmJudge(llm: LLMClient): Judge {
  return {
    name: "llm",
    async judge(c, signal) {
      const evidence = c.evidenceSincePhase
        .map(
          (item) =>
            `${item.id} ${item.tool}${item.claim ? ` claim=${item.claim}` : ""}${item.summary ? `: ${item.summary}` : ""}${item.ok ? "" : " (failed)"}`,
        )
        .join("\n");
      const result = await completeStructured(llm, {
        name: "task_judge",
        schema: JUDGE_SCHEMA,
        parse: parseLlmVerdict,
        ...(signal ? { signal } : {}),
        messages: [
          {
            role: "system",
            content: [
              "You are a strict, practical evidence judge.",
              "The agent wrote a contract and a claim for each linked evidence item.",
              "Score each requirement as cleared, insufficient, or unproven.",
              "Cleared means the cited evidence establishes the requirement; a claim that restates the requirement, names a test without its output, or cites an edit without a passing check is insufficient.",
              "Return per-requirement verdicts, a confidence from 0 to 1, and a short rationale. Do not decide whether the agent may run tools.",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `REQUEST:\n${c.request}`,
              `PHASE:\n- ${c.phase.id}: ${c.phase.goal}${c.phase.guidance ? ` ${c.phase.guidance}` : ""}`,
              `LEDGER:\n${renderLedger(c.ledger, { includeSource: false })}`,
              `EVIDENCE SINCE PHASE:\n${evidence || "(none)"}`,
              `AGENT REASON:\n${c.agentReason ?? "(none)"}`,
            ].join("\n\n"),
          },
        ],
      });
      return {
        ...result.value,
        model: llm.model,
        ...(result.response.usage ? { usage: result.response.usage } : {}),
      };
    },
  };
}
