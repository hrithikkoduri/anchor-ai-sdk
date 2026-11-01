/** Verifier configuration shared by EngineOptions and the ledger gates. */
import type { LLMClient } from "../llm/types.js";
import type { Judge } from "../verify/judge.js";

export interface VerifierConfig {
  /** Preferred transport-neutral judge. */
  judge?: Judge;
  /** Sugar for `llmJudge(llm)`, kept for compatibility. */
  llm?: LLMClient;
  /** Who creates the contract: the agent mid-run (default) or run start. */
  create?: "agent" | "start";
  /** Which boundaries are verified. Default both. */
  gates?: Array<"phase" | "finish">;
  /**
   * Whether a plain text reply — an answer, no `finish` call — is held to the
   * contract. Default true: a reply is the run's last word, so the completion
   * gate checks it like a `finish`. Set false when replies are conversation,
   * not completion (a lead answering the user's question while the work is
   * still open): the reply ends the turn, the contract stays as it was, and
   * only an explicit `finish` is judged.
   */
  gateReply?: boolean;
  /** Allow a requirement with a verifier-approved flaky waiver. */
  allowWaived?: boolean;
  /** Hard cap on judge calls per run. Default 8. */
  maxCallsPerTask?: number;
  /** Rejections allowed in one phase before a forced transition. Default 3. */
  maxRejectionsPerPhase?: number;
  /** Judge outage policy. Default allow-with-warning. */
  onError?: "allow" | "block";
}
