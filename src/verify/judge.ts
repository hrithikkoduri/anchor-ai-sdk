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

export interface JevThresholds {
  /** At or above this probability a requirement is cleared. */
  cleared?: number;
  /** At or below this probability a requirement is unproven. */
  rejected?: number;
}

export interface JevJudgeOptions {
  apiKey: string;
  model?: string;
  /** Full System One endpoint; defaults to TypeSafe's `/v1/systemone`. */
  endpoint?: string;
  thresholds?: JevThresholds;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface JevResponse {
  [key: string]: unknown;
}

function probabilityOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  for (const key of ["probability", "prob", "p", "value", "score"]) {
    if (typeof row[key] === "number") return row[key] as number;
  }
  if (row.noul && typeof row.noul === "object") {
    return probabilityOf(row.noul);
  }
  if (row.answer && typeof row.answer === "object") {
    return probabilityOf(row.answer);
  }
  return undefined;
}

function answerMap(body: JevResponse): Record<string, unknown> {
  for (const key of ["answers", "results", "decisions", "outputs"]) {
    const value = body[key];
    if (Array.isArray(value)) {
      return Object.fromEntries(
        value.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const row = item as Record<string, unknown>;
          const name = row.id ?? row.name ?? row.question;
          return typeof name === "string" ? [[name, row]] : [];
        }),
      );
    }
    if (value && typeof value === "object") {
      return value as Record<string, unknown>;
    }
  }
  return body;
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * TypeSafe AI's Jev/System One judge. It asks binary `noul` questions and maps
 * calibrated probabilities to the same verdict shape as `llmJudge`.
 *
 * This is deliberately not an LLMClient: Jev is a typed decision model, not a
 * chat completion endpoint.
 */
export function jevJudge(options: JevJudgeOptions): Judge {
  const endpoint = options.endpoint ?? "https://api.typesafe.ai/v1/systemone";
  const thresholds = {
    cleared: options.thresholds?.cleared ?? 0.8,
    rejected: options.thresholds?.rejected ?? 0.5,
  };
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "jev",
    async judge(c, signal) {
      const requirements = c.ledger.requirements.filter(
        (item) =>
          item.required &&
          item.status !== "superseded" &&
          (c.phase.id === "finish" || item.phase === c.phase.id),
      );
      const questions: Record<string, { type: "noul"; question: string }> = {
        phase_complete: {
          type: "noul",
          question:
            "The agent's work in this phase is complete enough to leave it.",
        },
      };
      for (const requirement of requirements) {
        const linked = requirement.evidenceIds
          .map((id) => c.ledger.evidence[id])
          .filter((item): item is LedgerEvidenceRef => Boolean(item));
        const evidence = linked
          .map(
            (item) =>
              `${item.tool}${item.claim ? ` claim=${item.claim}` : ""}${item.summary ? `: ${item.summary}` : ""}${item.ok ? "" : " (failed)"}`,
          )
          .join("; ");
        questions[requirement.id] = {
          type: "noul",
          question:
            `The cited evidence establishes: ${requirement.text}. ` +
            `The agent's claim is: ${linked[0]?.claim ?? "(none)"}. ` +
            `Evidence: ${evidence || "(none)"}. Reject claims that restate the requirement, ` +
            "name a test without its output, or cite an edit without a passing check.",
        };
      }

      const state = {
        request: c.request,
        phase: { id: c.phase.id, goal: c.phase.goal },
        requirements: requirements.map((item) => ({
          id: item.id,
          text: item.text,
          phase: item.phase,
          status: item.status,
          claim: item.evidenceIds
            .map((id) => c.ledger.evidence[id]?.claim)
            .find(Boolean),
          evidence: item.evidenceIds
            .map((id) => c.ledger.evidence[id])
            .filter(Boolean),
        })),
        agentReason: c.agentReason,
      };

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? 30_000,
      );
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: options.model ?? "jev-latest",
            state,
            questions,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            `Jev API error ${response.status}: ${(await response.text()).slice(0, 300)}`,
          );
        }
        const body = (await response.json()) as JevResponse;
        const answers = answerMap(body);
        const phaseProbability = clampProbability(
          probabilityOf(answers.phase_complete) ?? 0,
        );
        const verdictRequirements = requirements.map((requirement) => {
          const probability = clampProbability(
            probabilityOf(answers[requirement.id]) ?? 0,
          );
          const status =
            probability >= thresholds.cleared
              ? "cleared"
              : probability <= thresholds.rejected
                ? "unproven"
                : "insufficient";
          return {
            id: requirement.id,
            status: status as JudgeRequirementStatus,
            probability,
          };
        });
        const probabilities = [
          phaseProbability,
          ...verdictRequirements
            .filter((item) => item.status !== "cleared" || item.probability !== undefined)
            .map((item) => item.probability ?? 0),
        ];
        return {
          cleared:
            phaseProbability >= thresholds.cleared &&
            verdictRequirements.every((item) => item.status === "cleared"),
          requirements: verdictRequirements,
          confidence: Math.min(...probabilities),
          model: options.model ?? "jev-latest",
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
