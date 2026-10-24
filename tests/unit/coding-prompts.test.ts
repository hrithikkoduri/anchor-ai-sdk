import { describe, expect, it } from "vitest";
import {
  buildCodingPrompt,
  character,
  codingPromptComponents,
  tone,
} from "../../src/agents/coding/index.js";

describe("coding prompt components", () => {
  it("exports the default sections for amendment", () => {
    expect(codingPromptComponents).toMatchObject({
      character,
      tone,
    });
    expect(buildCodingPrompt({ character: "custom character" })).toContain(
      "# Character\ncustom character",
    );
  });

  it("keeps the default phases intro and allows an override", () => {
    expect(buildCodingPrompt()).toContain(
      "These describe your approach, not prerequisites.",
    );
    const prompt = buildCodingPrompt({
      phasesIntro:
        "For contracted work, follow the declared requirement graph and do not skip prerequisites.",
    });
    expect(prompt).toContain(
      "For contracted work, follow the declared requirement graph and do not skip prerequisites.",
    );
    expect(prompt).not.toContain(
      "These describe your approach, not prerequisites.",
    );
  });
});
