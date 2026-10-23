/**
 * Compaction — the context-window manager for long-lived threads.
 *
 * A thread that lives for days accumulates messages; sending the whole
 * history every run eventually exceeds the model's context window. Standard
 * fix, implemented here: when the conversation estimate crosses a threshold,
 * ask the LLM to fold the OLDEST span into the running summary (one call), and
 * keep a recent verbatim tail. The conversation is then still complete — in
 * two tiers: summary (compressed old work) + messages (recent work).
 *
 * Protocol safety (the subtle part): a kept span must never START with a
 * `tool` message, because tool results are meaningless without the assistant
 * turn that requested them. The cut slides forward to the first non-tool
 * message, so every kept assistant-with-tool_calls has its results with it.
 */
import type { LLMClient, LLMMessage, LLMUsage } from "../llm/types.js";
import { completeStructured } from "../llm/structured.js";
import type { ProgressLedger } from "../ledger/types.js";
import { renderLedger } from "../ledger/ledger.js";
import { conversationHistory } from "./context.js";

export interface CompactionConfig {
  /** Compact when the conversation estimate exceeds this (estimated tokens, chars/4). */
  maxEstimatedTokens?: number;
  /** How much of the tail to keep verbatim. */
  keepRecentTokens?: number;
}

/**
 * Durable state that replaces the folded part of a task conversation. The
 * engine builds this with structured output; consumers persist it through
 * their existing ThreadStore. The core fields are SDK-owned so the next
 * window can be reconstructed without trusting a prose summary.
 */
export interface CompactionHandoff {
  task: string;
  requirements: Array<{
    id: string;
    text: string;
    status: string;
    evidence: string[];
  }>;
  completed: string[];
  currentState: string;
  openFailures: string[];
  nextSteps: string[];
  constraints: string[];
  lastObservations: string[];
  git: {
    head?: string;
    checkpoint?: string;
    dirty?: boolean;
  };
}

const HANDOFF_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    task: { type: "string" },
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          status: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["id", "text", "status", "evidence"],
        additionalProperties: false,
      },
    },
    completed: { type: "array", items: { type: "string" } },
    currentState: { type: "string" },
    openFailures: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    lastObservations: { type: "array", items: { type: "string" } },
    git: {
      type: "object",
      properties: {
        head: { type: "string" },
        checkpoint: { type: "string" },
        dirty: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  required: [
    "task",
    "requirements",
    "completed",
    "currentState",
    "openFailures",
    "nextSteps",
    "constraints",
    "lastObservations",
    "git",
  ],
  additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("expected an array of strings");
  return value.map((item) => {
    if (typeof item !== "string") throw new Error("expected a string");
    return item;
  });
}

function parseCompactionHandoff(value: unknown): CompactionHandoff {
  if (!isRecord(value)) throw new Error("expected an object");
  if (typeof value.task !== "string") throw new Error("task must be a string");
  if (typeof value.currentState !== "string")
    throw new Error("currentState must be a string");
  if (!Array.isArray(value.requirements))
    throw new Error("requirements must be an array");
  const requirements = value.requirements.map((item) => {
    if (!isRecord(item)) throw new Error("requirement must be an object");
    if (typeof item.id !== "string" || typeof item.text !== "string")
      throw new Error("requirement id/text must be strings");
    if (typeof item.status !== "string")
      throw new Error("requirement status must be a string");
    return {
      id: item.id,
      text: item.text,
      status: item.status,
      evidence: strings(item.evidence),
    };
  });
  const git = isRecord(value.git) ? value.git : {};
  return {
    task: value.task,
    requirements,
    completed: strings(value.completed),
    currentState: value.currentState,
    openFailures: strings(value.openFailures),
    nextSteps: strings(value.nextSteps),
    constraints: strings(value.constraints),
    lastObservations: strings(value.lastObservations),
    git: {
      ...(typeof git.head === "string" ? { head: git.head } : {}),
      ...(typeof git.checkpoint === "string"
        ? { checkpoint: git.checkpoint }
        : {}),
      ...(typeof git.dirty === "boolean" ? { dirty: git.dirty } : {}),
    },
  };
}

/** Render the durable handoff as the turn-scoped state block. */
export function renderCompactionHandoff(handoff: CompactionHandoff): string {
  const list = (items: string[]) =>
    items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
  return [
    "## Durable task handoff",
    "This is authoritative state restored after a context reset, not a new user request.",
    `TASK: ${handoff.task}`,
    `CURRENT STATE: ${handoff.currentState}`,
    "",
    "REQUIREMENTS:",
    list(
      handoff.requirements.map(
        (item) =>
          `${item.id} [${item.status}] ${item.text}${item.evidence.length ? ` (evidence: ${item.evidence.join(", ")})` : ""}`,
      ),
    ),
    "",
    "COMPLETED:",
    list(handoff.completed),
    "OPEN FAILURES:",
    list(handoff.openFailures),
    "NEXT STEPS:",
    list(handoff.nextSteps),
    "CONSTRAINTS:",
    list(handoff.constraints),
    "LAST OBSERVATIONS:",
    list(handoff.lastObservations),
    ...(handoff.git.head || handoff.git.checkpoint
      ? [
          "GIT:",
          `- head: ${handoff.git.head ?? "unknown"}`,
          `- checkpoint: ${handoff.git.checkpoint ?? "none"}`,
        ]
      : []),
  ].join("\n");
}

export const DEFAULT_COMPACTION = {
  maxEstimatedTokens: 80_000,
  keepRecentTokens: 30_000,
} as const;

/** The working range the derived fold budget stays inside (product decision:
 * folds land in the 200–300k range on big-window models). */
export const COMPACTION_MAX_CEILING = 300_000;
export const COMPACTION_MIN_FLOOR = 48_000;
/** Fold at ~55% of the window: the chars/4 estimate undercounts real tokens. */
export const COMPACTION_WINDOW_FRACTION = 0.55;

/**
 * Compaction budgets for a model with `contextLength` tokens — so switching
 * models cannot silently break: a 1M-window folds at the 300k ceiling, a
 * 128k-window at ~70k, and a tiny window stays proportionally below itself.
 * The verbatim tail keeps the recent quarter.
 */
export function compactionForContextWindow(
  contextLength: number,
  opts: { ceiling?: number; floor?: number } = {},
): CompactionConfig {
  const ceiling = opts.ceiling ?? COMPACTION_MAX_CEILING;
  const floor = Math.min(
    opts.floor ?? COMPACTION_MIN_FLOOR,
    contextLength * 0.7,
  );
  const maxEstimatedTokens = Math.max(
    floor,
    Math.min(ceiling, contextLength * COMPACTION_WINDOW_FRACTION),
  );
  return {
    maxEstimatedTokens: Math.round(maxEstimatedTokens),
    keepRecentTokens: Math.round(maxEstimatedTokens * 0.25),
  };
}

/** Rough token estimate: characters / 4, plus tool-call overhead. No tokenizer dependency. */
export function estimateTokens(messages: LLMMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    // Provider image pricing varies; count the URL/alt plus a small fixed
    // overhead so an image-bearing turn is not estimated as free.
    for (const image of m.images ?? []) {
      chars += image.url.length + (image.alt?.length ?? 0) + 400;
    }
    for (const tc of m.tool_calls ?? []) {
      chars += tc.name.length + tc.arguments.length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Where to cut: everything from the returned index onward is KEPT verbatim.
 * Returns -1 when compaction isn't possible (the tail alone fills the budget)
 * or wouldn't be safe/sensible.
 */
export function findCompactionCut(
  messages: LLMMessage[],
  keepRecentTokens: number,
): number {
  let kept = 0;
  let cut = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    kept += estimateTokens([messages[i]!]);
    if (kept >= keepRecentTokens) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return -1; // tail alone already fills the keep-budget

  // Protocol safety: a kept span must not start with a tool result.
  while (cut < messages.length && messages[cut]!.role === "tool") cut += 1;
  if (cut >= messages.length) return -1; // nothing left to keep
  if (cut < 2) return -1; // messages[0] is the system prompt; need something besides it to summarize
  return cut;
}

export interface CompactionOutcome {
  /** A compact prose view for compatibility/events; structured path also has handoff. */
  summary: string;
  /** Structured state, when the task/ledger path produced it. */
  handoff?: CompactionHandoff;
  /** The verbatim tail that was kept. */
  keptMessages: LLMMessage[];
  removedCount: number;
  /** Truncated transcript of what was folded away — trace/journal material. */
  foldingPreview: string;
  usage: LLMUsage;
}

/** Folded-transcript preview cap: enough to see what was folded, small enough
 * that one compaction event cannot bloat the journal. */
const FOLDING_PREVIEW_CHARS = 6_000;

const COMPACT_SYSTEM = `You are compacting an AI agent's working conversation into a dense factual summary. Preserve user requests and corrections, observations, attempted commands and edits, their actual outcomes, file locations, verification status, and unresolved blockers. Distinguish earlier tasks from the current request. Do not carry old phase directives or engine nudges forward as instructions. Do not invent completed actions or requirements. Output ONLY the summary text.`;

function renderTranscript(messages: LLMMessage[]): string {
  const parts: string[] = [];
  for (const m of conversationHistory(messages)) {
    if (m.role === "assistant") {
      if (m.content) parts.push(`assistant: ${m.content}`);
      for (const tc of m.tool_calls ?? [])
        parts.push(`assistant → ${tc.name}(${tc.arguments})`);
    } else if (m.role === "tool") {
      parts.push(`tool result: ${m.content ?? ""}`);
    } else {
      parts.push(`${m.role}: ${m.content ?? ""}`);
    }
    for (const image of m.images ?? []) {
      parts.push(
        `[image ${image.id} ${image.mime}${image.alt ? `: ${image.alt}` : ""}]`,
      );
    }
  }
  return parts.join("\n");
}

/**
 * Fold the oldest span into a summary. Returns null when compaction isn't
 * possible (unsafe cut, nothing to summarize) or the model returned nothing —
 * callers then simply continue with the intact conversation.
 */
export async function compactConversation(args: {
  llm: LLMClient;
  messages: LLMMessage[];
  runningSummary?: string;
  keepRecentTokens: number;
  signal?: AbortSignal;
}): Promise<CompactionOutcome | null> {
  const cut = findCompactionCut(args.messages, args.keepRecentTokens);
  if (cut === -1) return null;

  const summarizable = args.messages.slice(1, cut); // skip the system prompt
  if (summarizable.length === 0 || estimateTokens(summarizable) === 0)
    return null;

  const userContent = [
    args.runningSummary
      ? `Existing summary of even earlier work:\n${args.runningSummary}\n`
      : "",
    `Transcript to fold in:\n${renderTranscript(summarizable)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await args.llm.complete(
    {
      messages: [
        { role: "system", content: COMPACT_SYSTEM },
        { role: "user", content: userContent },
      ],
      maxTokens: 2000,
    },
    { signal: args.signal },
  );

  const summary = response.text.trim();
  if (summary === "") return null; // nothing usable — keep the conversation intact

  const folded = renderTranscript(summarizable);
  return {
    summary,
    keptMessages: args.messages.slice(cut),
    removedCount: summarizable.length,
    foldingPreview:
      folded.length > FOLDING_PREVIEW_CHARS
        ? `${folded.slice(0, FOLDING_PREVIEW_CHARS)}\n[... folded transcript truncated for the record — ${folded.length} chars total ...]`
        : folded,
    usage: response.usage,
  };
}


/**
 * Fold a task conversation into the SDK-owned handoff contract. This is used
 * only when a ledger/verifier is active; plain chat keeps the legacy summary
 * path. A malformed response returns null so the caller retains the intact
 * conversation rather than silently losing state.
 */
export async function compactConversationStructured(args: {
  llm: LLMClient;
  messages: LLMMessage[];
  previousSummary?: string;
  previousHandoff?: CompactionHandoff;
  ledger?: ProgressLedger;
  git?: CompactionHandoff["git"];
  keepRecentTokens: number;
  signal?: AbortSignal;
}): Promise<CompactionOutcome | null> {
  const cut = findCompactionCut(args.messages, args.keepRecentTokens);
  if (cut === -1) return null;

  const summarizable = args.messages.slice(1, cut);
  if (summarizable.length === 0 || estimateTokens(summarizable) === 0)
    return null;

  const userContent = [
    args.previousSummary
      ? `Previous prose summary:\n${args.previousSummary}\n`
      : "",
    args.previousHandoff
      ? `Previous durable handoff:\n${renderCompactionHandoff(args.previousHandoff)}\n`
      : "",
    args.ledger ? `Authoritative ledger:\n${renderLedger(args.ledger)}\n` : "",
    args.git
      ? `Git state: ${JSON.stringify(args.git)}\n`
      : "Git state: unknown\n",
    `Transcript to fold in:\n${renderTranscript(summarizable)}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const structured = await completeStructured(args.llm, {
      name: "compaction_handoff",
      messages: [
        {
          role: "system",
          content:
            "You compact an agent task into a durable handoff. Preserve the task, requirements and their status, evidence ids, completed work, current state, open failures, next steps, constraints, and last observations. Do not invent completed work or evidence. The ledger is authoritative; keep its requirement ids and statuses. Return only the schema-bound object.",
        },
        { role: "user", content: userContent },
      ],
      schema: HANDOFF_SCHEMA,
      parse: parseCompactionHandoff,
      maxTokens: 2400,
      signal: args.signal,
    });
    return {
      handoff: {
        ...structured.value,
        ...(args.git ? { git: { ...structured.value.git, ...args.git } } : {}),
      },
      summary: renderCompactionHandoff({
        ...structured.value,
        ...(args.git ? { git: { ...structured.value.git, ...args.git } } : {}),
      }),
      keptMessages: args.messages.slice(cut),
      removedCount: summarizable.length,
      foldingPreview: previewFold(summarizable),
      usage: structured.response.usage,
    };
  } catch {
    return null;
  }
}

function previewFold(messages: LLMMessage[]): string {
  const folded = renderTranscript(messages);
  return folded.length > FOLDING_PREVIEW_CHARS
    ? `${folded.slice(0, FOLDING_PREVIEW_CHARS)}\n[... folded transcript truncated for the record — ${folded.length} chars total ...]`
    : folded;
}
