/**
 * Tool-result elision — the cheap step before an LLM fold.
 *
 * Most of a long run's prompt is stale tool output: a file read twenty steps
 * ago, a test log already acted on. The only relief used to be compaction, a
 * model call that summarises the past (expensive, and lossy: a fold can come
 * back as a few hundred characters). This pass is deterministic instead: when
 * the model's view goes over the trigger, the OLDEST tool results are
 * replaced with a one-line marker that keeps the fact of the call (tool,
 * status, size, what it was about) and drops the bulk. LLM compaction stays
 * as the backstop when elision cannot get the view under the trigger.
 *
 * Rules, each load-bearing:
 *
 *   - Only `tool` messages are candidates. The system prompt, user turns and
 *     assistant turns (and their tool calls) are never touched, so the
 *     protocol shape — every tool call followed by its result — is unchanged.
 *   - The current turn's results (those answering the latest assistant tool
 *     calls) and the last `keepRecent` results are kept verbatim.
 *   - `keepTools` (load_skill by default: instructions, not observations) are
 *     kept, and so is the latest result matching `pinLatest` — the loop pins
 *     the latest run of a workflow's check so the model still sees it.
 *   - It elides in one batch, down to `targetTokens`, not one result per call:
 *     each pass changes the prompt prefix once, so a provider cache reset is
 *     paid once per batch rather than every turn.
 *   - Deterministic: the same messages and options give the same output, and
 *     an already-elided result is never re-elided, so a second pass is a no-op.
 *
 * Like assistant-text elision, it is a projection: the loop keeps `messages`
 * whole and only changes what is sent.
 */
import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import { estimateTokens } from "./compaction.js";

/** Consumer-facing knobs (`EngineOptions.toolResultElision`). */
export interface ToolResultElisionConfig {
  /** Elide when the model's view exceeds this (estimated tokens, chars/4). Default: the compaction trigger. */
  triggerTokens?: number;
  /** One pass elides down to this. Default: half of `triggerTokens`. */
  targetTokens?: number;
  /** The most recent tool results always kept verbatim. Default 4. */
  keepRecent?: number;
  /** Results this short are not worth a marker. Default 1,000 chars. */
  minChars?: number;
  /** Tools whose results are never elided. Default `["load_skill"]`. */
  keepTools?: readonly string[];
}

export const DEFAULT_TOOL_RESULT_ELISION = {
  triggerTokens: 80_000,
  targetFraction: 0.5,
  keepRecent: 4,
  minChars: 1_000,
  keepTools: ["load_skill"] as readonly string[],
} as const;

/** The call a tool result answers, with its arguments parsed (best-effort). */
export interface ElisionCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ElideToolResultsOptions {
  triggerTokens: number;
  targetTokens: number;
  keepRecent: number;
  minChars: number;
  keepTools: readonly string[];
  /** The latest result whose call matches is kept verbatim. */
  pinLatest?: (call: ElisionCall) => boolean;
}

export interface ElidedToolResults {
  /** Index-aligned with the input; unchanged messages keep their identity. */
  messages: LLMMessage[];
  /** Indexes of the results elided by THIS pass, oldest first. */
  elided: number[];
  tokensBefore: number;
  tokensAfter: number;
}

/** Every marker starts with this; it is also how a pass recognises its own work. */
export const ELIDED_PREFIX = "[elided: ";

export function isElided(message: LLMMessage): boolean {
  return message.role === "tool" && (message.content ?? "").startsWith(ELIDED_PREFIX);
}

/** Resolve consumer config against the compaction trigger. */
export function resolveToolResultElision(
  config: ToolResultElisionConfig,
  compactionTrigger: number | undefined,
): Omit<ElideToolResultsOptions, "pinLatest"> {
  const triggerTokens =
    config.triggerTokens ?? compactionTrigger ?? DEFAULT_TOOL_RESULT_ELISION.triggerTokens;
  return {
    triggerTokens,
    targetTokens: Math.min(
      triggerTokens,
      config.targetTokens ??
        Math.floor(triggerTokens * DEFAULT_TOOL_RESULT_ELISION.targetFraction),
    ),
    keepRecent: Math.max(0, config.keepRecent ?? DEFAULT_TOOL_RESULT_ELISION.keepRecent),
    minChars: config.minChars ?? DEFAULT_TOOL_RESULT_ELISION.minChars,
    keepTools: config.keepTools ?? DEFAULT_TOOL_RESULT_ELISION.keepTools,
  };
}

function parseCall(call: LLMToolCall): ElisionCall {
  try {
    const parsed: unknown = JSON.parse(call.arguments || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return { name: call.name, input: parsed as Record<string, unknown> };
  } catch {
    // Unparseable arguments still identify the call by name.
  }
  return { name: call.name, input: {} };
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const size = (chars: number): string =>
  chars >= 1_000 ? `${(chars / 1_000).toFixed(1)}k` : String(chars);

/** What the call was about, from the fields the built-in tools use. */
function gist(call: ElisionCall | undefined): string | undefined {
  if (!call) return undefined;
  for (const key of ["command", "path", "pattern", "query", "file", "url"]) {
    const value = call.input[key];
    if (typeof value === "string" && value.trim()) return oneLine(value, 120);
  }
  return undefined;
}

/** The status line exec-backed tools put first (see `formatExec`). */
function status(content: string): string | undefined {
  const first = content.split("\n", 1)[0] ?? "";
  const exit = /^exit code (-?\d+)/.exec(first);
  if (exit) return `exit ${exit[1]}`;
  if (/^command exceeded its/.test(first)) return "timed out";
  if (/^execution request failed/.test(first)) return "completion unknown";
  if (/^error:/.test(first)) return "error";
  return undefined;
}

/** The marker that replaces an elided result. Stable text: it becomes prefix. */
export function elisionMarker(call: ElisionCall | undefined, content: string): string {
  const facts = [call?.name ?? "tool", status(content), `${size(content.length)} chars`]
    .filter(Boolean)
    .join(", ");
  const about = gist(call);
  const saved = /full output saved: (\S+)/.exec(content)?.[1];
  return (
    `${ELIDED_PREFIX}${facts}]` +
    (about ? ` ${about}` : "") +
    ` — older result removed to save context; ` +
    (saved ? `full output at ${saved}, or re-run the call to see it.` : "re-run the call to see it.")
  );
}

/**
 * One elision pass over the model's view. A no-op (same array contents) when
 * the view is within `triggerTokens` or nothing is eligible.
 */
export function elideToolResults(
  messages: readonly LLMMessage[],
  opts: ElideToolResultsOptions,
): ElidedToolResults {
  const tokensBefore = estimateTokens(messages as LLMMessage[]);
  const out = [...messages];
  const unchanged = { messages: out, elided: [], tokensBefore, tokensAfter: tokensBefore };
  if (tokensBefore <= opts.triggerTokens) return unchanged;

  const calls = new Map<string, ElisionCall>();
  let currentTurn = -1;
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return;
    currentTurn = index;
    for (const call of message.tool_calls) calls.set(call.id, parseCall(call));
  });

  const results: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "tool") results.push(index);
  });
  const protectedIndexes = new Set(results.slice(Math.max(0, results.length - opts.keepRecent)));
  for (const index of results) if (index > currentTurn && currentTurn >= 0) protectedIndexes.add(index);
  if (opts.pinLatest) {
    for (let i = results.length - 1; i >= 0; i--) {
      const index = results[i]!;
      const call = calls.get(messages[index]!.tool_call_id ?? "");
      if (call && opts.pinLatest(call)) {
        protectedIndexes.add(index);
        break;
      }
    }
  }

  const elided: number[] = [];
  let chars = tokensBefore * 4;
  const targetChars = opts.targetTokens * 4;
  for (const index of results) {
    if (chars <= targetChars) break;
    const message = messages[index]!;
    const content = message.content ?? "";
    if (protectedIndexes.has(index) || isElided(message) || content.length < opts.minChars) continue;
    const call = calls.get(message.tool_call_id ?? "");
    if (call && opts.keepTools.includes(call.name)) continue;
    const marker = elisionMarker(call, content);
    if (marker.length >= content.length) continue;
    out[index] = { ...message, content: marker };
    chars -= content.length - marker.length;
    elided.push(index);
  }
  if (!elided.length) return unchanged;
  return { messages: out, elided, tokensBefore, tokensAfter: estimateTokens(out) };
}
