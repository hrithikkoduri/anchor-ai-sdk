import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import { chatStrategy } from "../../src/agents/chat/index.js";
import { defineTool } from "../../src/tools/types.js";
import type { AgentEvent } from "../../src/engine/events.js";
import { userTurn } from "../../src/engine/types.js";
import { scripted, type Turn } from "../helpers/scripted.js";

/** A turn that spends the whole output cap thinking and emits no action. */
const reasoningOnly = (reasoning = "thinking"): Turn => ({
  reasoning,
  finishReason: "length",
  usage: {
    promptTokens: 100,
    completionTokens: 32_000,
    totalTokens: 32_100,
    reasoningTokens: 32_000,
  },
});

const inspect = defineTool(
  { name: "inspect", description: "Inspect the workspace", parameters: {} },
  async () => ({ ok: true, content: "workspace inspected" }),
);

const advisories = (events: AgentEvent[], kind: string) =>
  events.filter(
    (event) => event.type === "advisory" && event.kind === kind,
  );

describe("a reasoning-only turn at the output cap", () => {
  it("forces an action and finishes after the model calls a tool", async () => {
    const llm = scripted([
      reasoningOnly(),
      { tools: [{ name: "inspect", arguments: "{}" }] },
      { text: "Done." },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent(userTurn("inspect the workspace"), {
      llm,
      strategy: chatStrategy,
      tools: [inspect],
      maxOutputTokens: 32_000,
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("finished");
    expect(result.steps).toBe(3);
    expect(llm.seen).toHaveLength(3);
    expect(advisories(events, "reasoning_limit")).toHaveLength(1);

    // The continuation keeps the thread and forces a tool call on a smaller
    // budget, with the reasoning ceiling as the last thing the model reads.
    const forced = llm.seen[1]!;
    expect(forced.toolChoice).toBe("required");
    expect(forced.maxTokens).toBe(8_000);
    expect(forced.reasoningEffort).toBe("low");
    expect(forced.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("You have reached the reasoning limit."),
    });
    expect(forced.messages.at(-1)!.content ?? "").toContain(
      "call a tool (e.g. write the task) or return a concise answer.",
    );
  });

  it("pauses retryably after three forced continuations return nothing", async () => {
    const llm = scripted([
      reasoningOnly("one"),
      reasoningOnly("two"),
      reasoningOnly("three"),
      reasoningOnly("four"),
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent(userTurn("inspect the workspace"), {
      llm,
      strategy: chatStrategy,
      tools: [inspect],
      maxOutputTokens: 32_000,
      onEvent: (event) => events.push(event),
    });

    expect(result.reason).toBe("paused");
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("retry");
    expect(result.steps).toBe(4);
    expect(llm.seen).toHaveLength(4);
    expect(advisories(events, "reasoning_limit")).toHaveLength(3);
    expect(
      events.find(
        (event): event is Extract<AgentEvent, { type: "run_finished" }> =>
          event.type === "run_finished",
      )?.retryable,
    ).toBe(true);
  });

  it("omits tool_choice when the client does not support it", async () => {
    const inner = scripted([reasoningOnly(), { text: "Here is the answer." }]);
    const unsupported = { ...inner, supportsToolChoice: false };
    const result = await runAgent(userTurn("inspect the workspace"), {
      llm: unsupported,
      strategy: chatStrategy,
      tools: [inspect],
      maxOutputTokens: 32_000,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("finished");
    expect(inner.seen[1]!.toolChoice).toBeUndefined();
    expect(inner.seen[1]!.maxTokens).toBe(8_000);
  });

  it("leaves the existing capped-prose continuation unchanged", async () => {
    const llm = scripted([
      { text: "I was halfway through", finishReason: "length" },
      { text: "still writing the same essay", finishReason: "length" },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent(userTurn("explain the code"), {
      llm,
      strategy: chatStrategy,
      maxOutputTokens: 1_000,
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stalled");
    expect(result.retryable).toBeUndefined();
    expect(result.steps).toBe(2);
    expect(advisories(events, "output_cap_continue")).toHaveLength(1);
    expect(advisories(events, "reasoning_limit")).toHaveLength(0);
    expect(llm.seen[1]!.toolChoice).toBeUndefined();
    expect(llm.seen[1]!.maxTokens).toBe(1_000);
  });
});
