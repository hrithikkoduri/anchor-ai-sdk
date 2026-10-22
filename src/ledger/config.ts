/** Verifier configuration shared by EngineOptions and the ledger gates. */
import type { LLMClient } from "../llm/types.js";

export interface VerifierConfig {
  /** Separate/cheap verifier; absent = use the run's LLM for a separate call. */
  llm?: LLMClient;
  /** Which boundaries are verified. Default both. */
  gates?: Array<"phase" | "finish">;
  /** Allow a requirement with a verifier-approved flaky waiver. */
  allowWaived?: boolean;
  /** Hard cap on verifier calls per run. Default 6. */
  maxCallsPerTask?: number;
  /** Verifier outage policy. Default allow-with-warning. */
  onError?: "allow" | "block";
}
