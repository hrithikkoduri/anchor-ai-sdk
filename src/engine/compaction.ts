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
import { conversationHistory } from "./context.js";

export interface CompactionConfig {
  /** Compact when the conversation estimate exceeds this (estimated tokens, chars/4). */
  maxEstimatedTokens?: number;
  /** How much of the tail to keep verbatim. */
  keepRecentTokens?: number;
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
  /** The new running summary (prior summary + folded transcript). */
  summary: string;
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
