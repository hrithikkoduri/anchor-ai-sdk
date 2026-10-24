import { describe, expect, it } from "vitest";
import {
  createLedger,
  ledgerGate,
  linkEvidence,
  readyRequirements,
  recordEvidence,
  renderLedger,
  reviseLedger,
  setRequirementStatus,
  topologicalRequirements,
  unmetDependencies,
} from "../../src/ledger/index.js";

function createWith(
  requirements: Array<{
    id?: string;
    text: string;
    phase?: string;
    required?: boolean;
    dependsOn?: string[];
  }>,
) {
  return createLedger({
    taskId: "graph",
    source: "Ship the feature in dependency order.",
    requirements,
  });
}

function verify(ledger: ReturnType<typeof createWith>, id: string): void {
  const evidence = recordEvidence(ledger, {
    tool: "bash",
    ref: `message:${id}`,
    ok: true,
  });
  linkEvidence(ledger, id, evidence.id, `${id} is proven`);
  setRequirementStatus(ledger, id, "verified");
}

describe("ledger dependency graph", () => {
  it("accepts an acyclic graph and resolves forward references by id", () => {
    const ledger = createWith([
      { id: "publish", text: "Publish the package", dependsOn: ["schema"] },
      { id: "schema", text: "Define the schema" },
      { id: "wire", text: "Wire the endpoint", dependsOn: ["schema"] },
    ]);

    expect(ledger.requirements.map((item) => item.id)).toEqual([
      "publish",
      "schema",
      "wire",
    ]);
    expect(ledger.requirements[0]?.dependsOn).toEqual(["schema"]);
  });

  it("keeps the generated rN ids when no id is supplied", () => {
    const ledger = createWith([
      { text: "One" },
      { text: "Two", dependsOn: ["r1"] },
    ]);
    expect(ledger.requirements.map((item) => item.id)).toEqual(["r1", "r2"]);
  });

  it("does not let generated ids collide with explicit ids", () => {
    const ledger = createWith([
      { text: "Generated" },
      { id: "r1", text: "Explicit" },
    ]);
    expect(ledger.requirements.map((item) => item.id)).toEqual(["r2", "r1"]);
  });

  it("rejects an unknown dependency id", () => {
    expect(() =>
      createWith([{ text: "Dependent", dependsOn: ["missing"] }]),
    ).toThrow(/unknown requirement "missing"/);
  });

  it("rejects a self edge", () => {
    expect(() => createWith([{ id: "r2", text: "Self", dependsOn: ["r2"] }])).toThrow(
      /cannot depend on itself/,
    );
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      createWith([
        { id: "same", text: "One" },
        { id: "same", text: "Two" },
      ]),
    ).toThrow(/duplicate requirement id "same"/);
  });

  it("rejects invalid custom ids", () => {
    expect(() => createWith([{ id: "R2", text: "Bad" }])).toThrow(
      /invalid requirement id/,
    );
  });

  it("reports the cycle path instead of a generic graph error", () => {
    expect(() =>
      createWith([
        { id: "r1", text: "One", dependsOn: ["r3"] },
        { id: "r2", text: "Two", dependsOn: ["r1"] },
        { id: "r3", text: "Three", dependsOn: ["r2"] },
      ]),
    ).toThrow(/requirement dependency cycle: r1 → r3 → r2 → r1/);
  });

  it("rejects a dependency on a superseded requirement", () => {
    const ledger = createWith([{ id: "old", text: "Old" }]);
    expect(() =>
      reviseLedger(ledger, {
        reason: "replace the old requirement",
        supersede: ["old"],
        add: [{ id: "new", text: "New", dependsOn: ["old"] }],
      }),
    ).toThrow(/depends on superseded requirement "old"/);
    expect(ledger.revision).toBe(1);
    expect(ledger.requirements[0]?.status).toBe("open");
  });

  it("allows superseding both ends of an edge in one revision", () => {
    const ledger = createWith([
      { id: "base", text: "Base" },
      { id: "top", text: "Top", dependsOn: ["base"] },
    ]);
    reviseLedger(ledger, {
      reason: "replace both",
      supersede: ["top", "base"],
      add: [
        { id: "base2", text: "Base replacement" },
        { id: "top2", text: "Top replacement", dependsOn: ["base2"] },
      ],
    });
    expect(ledger.revision).toBe(2);
    expect(ledger.requirements.find((item) => item.id === "top")?.status).toBe(
      "superseded",
    );
    expect(
      ledger.requirements.find((item) => item.id === "top2")?.dependsOn,
    ).toEqual(["base2"]);
  });

  it("supports adding dependencies in a revision", () => {
    const ledger = createWith([{ id: "base", text: "Base" }]);
    reviseLedger(ledger, {
      reason: "add ordering",
      add: [{ id: "top", text: "Top", phase: "build", dependsOn: ["base"] }],
    });
    expect(ledger.requirements[1]).toMatchObject({
      id: "top",
      phase: "build",
      dependsOn: ["base"],
    });
  });

  it("reports unmet dependencies before verification", () => {
    const ledger = createWith([
      { id: "r2", text: "Dependent", dependsOn: ["r1"] },
      { id: "r1", text: "Prerequisite" },
    ]);
    expect(unmetDependencies(ledger, ledger.requirements[0]!)).toEqual(["r1"]);

    verify(ledger, "r1");
    expect(unmetDependencies(ledger, ledger.requirements[0]!)).toEqual([]);
  });

  it("blocks finish when a verified node has an unmet dependency", () => {
    const ledger = createWith([
      { id: "r2", text: "Dependent", dependsOn: ["r1"] },
      { id: "r1", text: "Prerequisite" },
    ]);
    // Simulate a legacy/corrupt state: r2 is verified while r1 is still open.
    verify(ledger, "r2");
    expect(ledgerGate(ledger)).toMatchObject({
      allow: false,
      unsatisfiedDependencies: ["r2 requires r1"],
    });
    verify(ledger, "r1");
    expect(ledgerGate(ledger)).toMatchObject({
      allow: true,
      unsatisfiedDependencies: [],
    });
  });

  it("honors allowWaived for dependent requirements", () => {
    const ledger = createWith([
      { id: "r2", text: "Dependent", dependsOn: ["r1"] },
      { id: "r1", text: "Prerequisite" },
    ]);
    for (const id of ["r1", "r2"]) {
      const evidence = recordEvidence(ledger, {
        tool: "bash",
        ref: `message:${id}`,
        ok: false,
      });
      linkEvidence(ledger, id, evidence.id, `waive ${id}`);
      setRequirementStatus(ledger, id, "waived");
    }

    expect(ledgerGate(ledger)).toMatchObject({
      allow: false,
      unsatisfiedDependencies: ["r2 requires r1"],
    });
    expect(ledgerGate(ledger, { allowWaived: true })).toMatchObject({
      allow: true,
      unsatisfiedDependencies: [],
    });
  });

  it("derives readiness without persisting it", () => {
    const ledger = createWith([
      { id: "base", text: "Base" },
      { id: "top", text: "Top", dependsOn: ["base"] },
      { id: "side", text: "Side", required: false },
    ]);
    expect(readyRequirements(ledger)).toEqual(["base", "side"]);
    expect(ledger).not.toHaveProperty("ready");

    verify(ledger, "base");
    expect(readyRequirements(ledger)).toEqual(["top", "side"]);
  });

  it("renders in topological order with after edges and a ready set", () => {
    const ledger = createWith([
      { id: "publish", text: "Publish", dependsOn: ["schema"] },
      { id: "schema", text: "Schema" },
    ]);
    const rendered = renderLedger(ledger);
    expect(rendered.indexOf("schema [open]")).toBeLessThan(
      rendered.indexOf("publish [open]"),
    );
    expect(rendered).toContain("publish [open] Publish after schema");
    expect(rendered).toContain("READY: schema");
    expect(topologicalRequirements(ledger.requirements).map((item) => item.id)).toEqual(
      ["schema", "publish"],
    );
  });

  it("leaves ledgers without dependencies in their original order", () => {
    const ledger = createWith([
      { text: "One" },
      { text: "Two" },
      { text: "Three" },
    ]);
    expect(
      topologicalRequirements(ledger.requirements).map((item) => item.id),
    ).toEqual(["r1", "r2", "r3"]);
    expect(renderLedger(ledger)).not.toContain(" after ");
    expect(renderLedger(ledger)).toContain("READY: r1, r2, r3");
  });
});
