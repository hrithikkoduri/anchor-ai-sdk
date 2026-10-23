import { describe, expect, it } from "vitest";
import type { LLMClient, LLMRequest } from "../../src/llm/types.js";
import {
  addRequirement,
  createLedger,
  linkEvidence,
  recordEvidence,
} from "../../src/ledger/index.js";
import { llmJudge } from "../../src/verify/index.js";

function ledgerWithEvidence() {
  const ledger = createLedger({
    taskId: "t",
    source: "Implement retry support",
    goal: "Retry requests safely",
  });
  addRequirement(ledger, { text: "Retry test passes", phase: "validate" });
  const evidence = recordEvidence(ledger, {
    tool: "run_tests",
    ref: "call:1",
    ok: true,
    summary: "2 tests passed",
  });
  linkEvidence(ledger, "r1", evidence.id, "The retry test passed.");
  return ledger;
}

describe("llmJudge", () => {
  it("returns per-requirement verdicts from the prose verifier", async () => {
    let request: LLMRequest | undefined;
    const llm: LLMClient = {
      model: "fake-verifier",
      complete: async (req) => {
        request = req;
        return {
          text: JSON.stringify({
            cleared: false,
            requirements: [
              { id: "r1", status: "insufficient", probability: 0.6 },
            ],
            confidence: 0.6,
            rationale: "The test name alone does not prove the retry path.",
          }),
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model: "fake-verifier",
          latencyMs: 1,
        };
      },
      stream: async () => {
        throw new Error("not used");
      },
    };
    const verdict = await llmJudge(llm).judge({
      request: "Implement retry support",
      phase: { id: "validate", goal: "verify the work" },
      ledger: ledgerWithEvidence(),
      evidenceSincePhase: [],
    });
    expect(request?.responseFormat).toMatchObject({ name: "task_judge" });
    expect(verdict).toMatchObject({
      cleared: false,
      confidence: 0.6,
      model: "fake-verifier",
      requirements: [
        { id: "r1", status: "insufficient", probability: 0.6 },
      ],
    });
  });
});
