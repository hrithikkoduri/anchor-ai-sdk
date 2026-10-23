import { describe, expect, it } from "vitest";
import type { ProgressLedger } from "../../src/ledger/types.js";
import {
  createLedger,
  linkEvidence,
  recordEvidence,
  addRequirement,
} from "../../src/ledger/index.js";
import { jevJudge } from "../../src/verify/index.js";

function fixture(): ProgressLedger {
  const ledger = createLedger({
    taskId: "t",
    source: "Implement retry support",
    goal: "Retry requests safely",
  });
  addRequirement(ledger, { text: "Retry test passes", phase: "validate" });
  addRequirement(ledger, { text: "No duplicate writes", phase: "validate" });
  const one = recordEvidence(ledger, {
    tool: "run_tests",
    ref: "call:1",
    ok: true,
    summary: "2 tests passed",
  });
  const two = recordEvidence(ledger, {
    tool: "probe",
    ref: "call:2",
    ok: true,
    summary: "looked at the diff",
  });
  linkEvidence(ledger, "r1", one.id, "The retry test passed.");
  linkEvidence(ledger, "r2", two.id, "The probe inspected the write path.");
  return ledger;
}

function fakeFetch(body: unknown, seen?: { body?: unknown; url?: string }) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    if (seen) {
      seen.url = String(url);
      seen.body = JSON.parse(String(init?.body));
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("jevJudge", () => {
  it("maps calibrated noul probabilities to per-requirement verdicts", async () => {
    const seen: { body?: unknown; url?: string } = {};
    const judge = jevJudge({
      apiKey: "test",
      fetchImpl: fakeFetch(
        {
          answers: {
            phase_complete: { probability: 0.9 },
            r1: { probability: 0.85 },
            r2: { probability: 0.4 },
          },
        },
        seen,
      ),
    });
    const verdict = await judge.judge({
      request: "Implement retry support",
      phase: { id: "validate", goal: "verify the work" },
      ledger: fixture(),
      evidenceSincePhase: [],
    });

    expect(seen.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen.body).toMatchObject({
      model: "jev-latest",
      questions: {
        phase_complete: { type: "noul" },
        r1: { type: "noul" },
        r2: { type: "noul" },
      },
    });
    expect(verdict).toMatchObject({
      cleared: false,
      confidence: 0.4,
      requirements: [
        { id: "r1", status: "cleared", probability: 0.85 },
        { id: "r2", status: "unproven", probability: 0.4 },
      ],
    });
  });

  it("honors custom thresholds and the insufficient band", async () => {
    const judge = jevJudge({
      apiKey: "test",
      thresholds: { cleared: 0.7, rejected: 0.4 },
      fetchImpl: fakeFetch({
        answers: {
          phase_complete: { probability: 0.75 },
          r1: { probability: 0.65 },
          r2: { probability: 0.41 },
        },
      }),
    });
    const verdict = await judge.judge({
      request: "Implement retry support",
      phase: { id: "validate", goal: "verify the work" },
      ledger: fixture(),
      evidenceSincePhase: [],
    });
    expect(verdict.cleared).toBe(false);
    expect(verdict.requirements).toMatchObject([
      { id: "r1", status: "insufficient" },
      { id: "r2", status: "insufficient" },
    ]);
  });

  it("fails on a non-2xx decision response", async () => {
    const judge = jevJudge({
      apiKey: "test",
      fetchImpl: async () =>
        new Response("nope", { status: 401 }),
    });
    await expect(
      judge.judge({
        request: "x",
        phase: { id: "validate", goal: "verify" },
        ledger: fixture(),
        evidenceSincePhase: [],
      }),
    ).rejects.toThrow(/Jev API error 401/);
  });
});
