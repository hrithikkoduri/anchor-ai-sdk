import { describe, expect, it } from "vitest";
import {
  addRequirement,
  createLedger,
  ledgerGate,
  linkEvidence,
  recordEvidence,
  renderLedger,
  reviseLedger,
  setRequirementStatus,
} from "../../src/ledger/index.js";

const base = () =>
  createLedger({
    taskId: "t1",
    source: "Fix the redirect bug and add a regression test.",
    requirements: [
      {
        text: "Preserve GET after a 303 → 307 chain",
        sourceQuote: "Fix the redirect bug",
      },
    ],
  });

describe("progress ledger", () => {
  it("creates requirements with stable readable ids and locks user items", () => {
    const ledger = base();
    expect(ledger.requirements).toHaveLength(1);
    expect(ledger.requirements[0]).toMatchObject({
      id: "r1",
      status: "open",
      locked: true,
      origin: "user",
      evidenceIds: [],
    });
  });

  it("records evidence and links it without copying the output", () => {
    const ledger = base();
    const evidence = recordEvidence(ledger, {
      tool: "bash",
      ref: "message:msg_1",
      ok: true,
      summary: "pytest test_redirect.py — exit 0",
    });
    linkEvidence(ledger, "r1", evidence.id);

    expect(evidence.id).toBe("e1");
    expect(ledger.requirements[0]?.evidenceIds).toEqual(["e1"]);
    expect(ledger.evidence.e1?.ref).toBe("message:msg_1");
  });

  it("blocks completion until required evidence is verified", () => {
    const ledger = base();
    expect(ledgerGate(ledger).allow).toBe(false);

    const evidence = recordEvidence(ledger, {
      tool: "bash",
      ref: "message:msg_1",
      ok: true,
    });
    linkEvidence(ledger, "r1", evidence.id);
    expect(ledgerGate(ledger)).toMatchObject({
      allow: false,
      open: ["r1"],
      missingEvidence: [],
    });

    setRequirementStatus(ledger, "r1", "verified");
    expect(ledgerGate(ledger).allow).toBe(true);
  });

  it("reports missing evidence separately from open requirements", () => {
    const ledger = base();
    expect(ledgerGate(ledger)).toMatchObject({
      allow: false,
      open: ["r1"],
      missingEvidence: ["r1"],
    });
  });

  it("keeps optional items out of the gate", () => {
    const ledger = base();
    addRequirement(ledger, { text: "Consider a docs update", required: false });
    setRequirementStatus(ledger, "r1", "verified");
    expect(ledgerGate(ledger).allow).toBe(true);
  });

  it("allows a waived requirement only when the policy permits it", () => {
    const ledger = base();
    const evidence = recordEvidence(ledger, {
      tool: "bash",
      ref: "message:msg_2",
      ok: false,
      summary: "known flaky test: 2 pass / 1 fail",
    });
    linkEvidence(ledger, "r1", evidence.id);
    setRequirementStatus(ledger, "r1", "waived");

    expect(ledgerGate(ledger).allow).toBe(false);
    expect(ledgerGate(ledger, { allowWaived: true }).allow).toBe(true);
  });

  it("supersedes on revision instead of deleting, and gates the new revision", () => {
    const ledger = base();
    setRequirementStatus(ledger, "r1", "verified");
    expect(ledgerGate(ledger).allow).toBe(true);

    reviseLedger(ledger, {
      reason: "User changed direction",
      nextStep: "Handle HEAD redirects",
      supersede: ["r1"],
      add: [{ text: "Preserve HEAD redirect behavior" }],
    });

    expect(ledger.revision).toBe(2);
    expect(ledger.requirements[0]?.status).toBe("superseded");
    expect(ledger.requirements[1]).toMatchObject({
      id: "r2",
      status: "open",
      locked: true,
      origin: "user",
    });
    expect(ledgerGate(ledger)).toMatchObject({
      allow: false,
      open: ["r2"],
      superseded: ["r1"],
    });
  });

  it("renders readable text, not bare ids", () => {
    const ledger = base();
    const evidence = recordEvidence(ledger, {
      tool: "bash",
      ref: "message:msg_1",
      ok: true,
      summary: "pytest — exit 0",
    });
    linkEvidence(ledger, "r1", evidence.id);

    const prompt = renderLedger(ledger);
    expect(prompt).toContain("Fix the redirect bug");
    expect(prompt).toContain("r1 [open] Preserve GET");
    expect(prompt).toContain("e1 bash: pytest — exit 0");
    expect(prompt).toContain("NEXT:");
  });
});
