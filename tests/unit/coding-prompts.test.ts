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
});
