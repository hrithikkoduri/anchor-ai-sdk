/**
 * Deterministic turn router. Clear chat costs no classifier call; clear task
 * work creates a contract; ambiguous messages ask before any task state is
 * created. Consumers can override with `intent`.
 */
export type TurnIntent = "chat" | "clarify" | "task";

const GREETING =
  /^(hi|hello|hey|yo|thanks|thank you|ok|okay|cool|great|nice|good morning|good evening)[.! ]*$/i;
const TASK_ACTION =
  /\b(fix|implement|add|remove|delete|refactor|rename|update|change|investigate|research|find|search|compare|review|debug|test|write|create|build|migrate|optimi[sz]e|explain the code|trace|locate)\b/i;
const CODE_REF =
  /(\b[\w.-]+\/[\w./-]+\b|\b[\w.-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|md|json|ya?ml|sql|sh)\b|`[^`]+`)/;
const QUESTION = /^(what|why|how|where|when|who|which|is|are|does|do|can|could|would|should)\b/i;

export function resolveTurnIntent(
  message: string,
  explicit: "auto" | TurnIntent = "auto",
): TurnIntent {
  if (explicit !== "auto") return explicit;
  const text = message.trim();
  if (!text) return "clarify";
  if (GREETING.test(text)) return "chat";
  if (TASK_ACTION.test(text) || CODE_REF.test(text)) return "task";
  if (QUESTION.test(text)) return "chat";
  // A bare request with no actionable verb is not enough to create a contract.
  if (/\b(can you|could you|please|help)\b/i.test(text)) return "clarify";
  return "clarify";
}
