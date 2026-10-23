import { describe, expect, it } from "vitest";
import { chatAgent } from "../../src/agents/chat/index.js";
import { createAnchor } from "../../src/anchor.js";
import { scripted } from "../helpers/scripted.js";

describe("createAnchor", () => {
  it("runs the captured agent and merges per-run overrides", async () => {
    const llm = scripted([{ text: "hello" }]);
    const anchor = createAnchor({
      llm,
      agent: chatAgent,
      defaults: { maxOutputTokens: 50 },
    });

    const result = await anchor.run("say hello", { maxOutputTokens: 123 });
    expect(result.ok).toBe(true);
    expect(llm.seen[0]!.messages.at(-1)).toMatchObject({
      role: "user",
      content: "say hello",
    });
    expect(llm.seen[0]!.maxTokens).toBe(123);
  });

  it("reports a cheap doctor status without starting a sandbox", async () => {
    const anchor = createAnchor({
      llm: scripted([{ text: "unused" }]),
      agent: chatAgent,
    });
    await expect(anchor.doctor()).resolves.toMatchObject({
      ok: true,
      agent: "chat",
      hasThread: false,
      model: "scripted",
    });
  });
});
