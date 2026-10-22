/**
 * Ledger compiler — one cheap structured call that turns the task plus the
 * agent's phase goals into a concrete, auditable contract.
 *
 * It does not plan the implementation and it does not decide completion. It
 * extracts what the user asked for; source quotes keep the requirements tied
 * to the authoritative task instead of letting the model invent scope.
 */
import { completeStructured } from "../llm/structured.js";
import type { LLMClient, LLMRequest, LLMUsage } from "../llm/types.js";
import { createLedger } from "./ledger.js";
import type { ProgressLedger } from "./types.js";

export interface PhaseGoal {
  id: string;
  goal: string;
  guidance?: string;
}

export interface CompileLedgerOptions {
  llm: LLMClient;
  taskId: string;
  task: string;
  phases: readonly PhaseGoal[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: LLMRequest["reasoningEffort"];
  signal?: AbortSignal;
}

export interface CompileLedgerResult {
  ledger: ProgressLedger;
  usage?: LLMUsage;
}

interface Draft {
  goal: string;
  requirements: Array<{
    text: string;
    required: boolean;
    sourceQuote?: string;
  }>;
}

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    goal: { type: "string" },
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          required: { type: "boolean" },
          sourceQuote: { type: "string" },
        },
        required: ["text", "required"],
        additionalProperties: false,
      },
    },
  },
  required: ["goal", "requirements"],
  additionalProperties: false,
};

function parseDraft(value: unknown): Draft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("compiler output must be an object");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.goal !== "string" || row.goal.trim() === "") {
    throw new Error("compiler output needs a non-empty goal");
  }
  if (!Array.isArray(row.requirements)) {
    throw new Error("compiler output needs a requirements array");
  }
  return {
    goal: row.goal.trim(),
    requirements: row.requirements.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`requirement ${index} must be an object`);
      }
      const req = item as Record<string, unknown>;
      if (typeof req.text !== "string" || req.text.trim() === "") {
        throw new Error(`requirement ${index} needs text`);
      }
      if (typeof req.required !== "boolean") {
        throw new Error(`requirement ${index} needs required`);
      }
      if (
        req.sourceQuote !== undefined &&
        typeof req.sourceQuote !== "string"
      ) {
        throw new Error(`requirement ${index} has an invalid sourceQuote`);
      }
      return {
        text: req.text.trim(),
        required: req.required,
        ...(req.sourceQuote ? { sourceQuote: req.sourceQuote } : {}),
      };
    }),
  };
}

export async function compileLedger(
  opts: CompileLedgerOptions,
): Promise<CompileLedgerResult> {
  const phases = opts.phases
    .map(
      (phase) =>
        `- ${phase.id}: ${phase.goal}${phase.guidance ? ` ${phase.guidance}` : ""}`,
    )
    .join("\n");

  const result = await completeStructured(opts.llm, {
    name: "ledger_contract",
    schema: SCHEMA,
    parse: parseDraft,
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
          "You compile a user task into a small, auditable task contract.",
          "Extract only what the user actually asks for. Do not plan implementation, invent requirements, or add generic engineering advice.",
          "Each requirement must be concrete and independently checkable. Mark optional follow-ups required=false.",
          "When a requirement comes from an explicit user sentence, put that exact substring in sourceQuote. Omit sourceQuote when inferring.",
          "The goal is one sentence describing the requested outcome.",
          "Use the phase goals only as context for what kinds of work are expected; do not turn phases into requirements.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `TASK:\n${opts.task}\n\nPHASES:\n${phases}`,
      },
    ],
  });

  const draft = result.value;
  const quoted = draft.requirements.map((requirement) => {
    const sourceQuote =
      requirement.sourceQuote && opts.task.includes(requirement.sourceQuote)
        ? requirement.sourceQuote
        : undefined;
    return {
      text: requirement.text,
      required: requirement.required,
      ...(sourceQuote ? { sourceQuote } : {}),
      origin: "compiled" as const,
    };
  });

  const ledger = createLedger({
    taskId: opts.taskId,
    source: opts.task,
    goal: draft.goal,
    requirements:
      quoted.length > 0
        ? quoted
        : [
            {
              text: draft.goal,
              required: true,
              origin: "compiled",
              sourceQuote: opts.task,
            },
          ],
  });

  return {
    ledger,
    ...(result.response.usage ? { usage: result.response.usage } : {}),
  };
}
