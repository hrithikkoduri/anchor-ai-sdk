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
  /** Allow a requirement with a verifier-approved flaky waiver. */
  allowWaived?: boolean;
  /** Hard cap on judge calls per run. Default 8. */
  maxCallsPerTask?: number;
  /** Rejections allowed in one phase before a forced transition. Default 3. */
  maxRejectionsPerPhase?: number;
  /** Judge outage policy. Default allow-with-warning. */
  onError?: "allow" | "block";
}
