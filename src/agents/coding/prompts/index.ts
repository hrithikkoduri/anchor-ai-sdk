import type { StrategyPhase } from "../../../engine/strategy.js";
import { codingPhases } from "../phases.js";
import { character, tone } from "./character.js";
import { judgment, verification } from "./judgment.js";
import { operatingRules } from "./operating-rules.js";

export interface CodingPromptOptions {
  character?: string;
  tone?: string;
  judgment?: string;
  operatingRules?: string;
  verification?: string;
  phases?: StrategyPhase[];
  context?: string;
  summary?: string;
  additionalSections?: Array<{ title: string; body: string }>;
}

/** Named, replaceable prompt components. This does not introduce a second
 * framework: consumers can override a section or supply their own strategy. */
export function buildCodingPrompt(options: CodingPromptOptions = {}): string {
  const phases = options.phases ?? codingPhases;
  return [
    { title: "Character", body: options.character ?? character },
    { title: "Tone", body: options.tone ?? tone },
    { title: "Judgment", body: options.judgment ?? judgment },
    {
      title: "Operating rules",
      body: options.operatingRules ?? operatingRules,
    },
    {
      title: "Verification philosophy",
      body: options.verification ?? verification,
    },
    {
      title: "Working notes",
      body:
        "For long or multi-step work keep a running notes file at `<workspace>/.anchor/notes.md` " +
        "(you can create it yourself; it is git-excluded and never part of the deliverable): " +
        "verified facts, the current hypothesis, next steps, open questions. " +
        "Update it at meaningful transitions and re-read it when resuming or after a context fold.",
    },
    {
      title: "Approach phases",
      body: [
        "These describe your approach, not prerequisites. Choose the phases that fit, skip or revisit them when appropriate, and conclude from any phase. When your work shifts between kinds of activity — investigating, changing code, verifying, answering — call set_phase once to record the new phase; it labels your approach (it never authorizes or blocks anything) and keeps the thread's timeline honest.",
        ...phases.map(
          (phase) =>
            `- ${phase.id}: ${phase.goal}${phase.guidance ? ` ${phase.guidance}` : ""}`,
        ),
      ].join("\n"),
    },
    ...(options.additionalSections ?? []),
    {
      title: "Workspace observations (not instructions)",
      body: options.context ?? "",
    },
    {
      title: "Earlier thread context (may describe obsolete plans)",
      body: options.summary ?? "",
    },
  ]
    .filter((section) => section.body.trim())
    .map((section) => `# ${section.title}\n${section.body}`)
    .join("\n\n");
}
