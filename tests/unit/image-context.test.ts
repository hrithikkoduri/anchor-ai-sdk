import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import { chatAgent } from "../../src/agents/chat/index.js";
import { scripted } from "../helpers/scripted.js";
import { MemoryInboxStore } from "../../src/engine/inbox.js";
import { userTurn } from "../../src/engine/types.js";

describe("image context", () => {
  it("carries image references into the initial user turn", async () => {
    const llm = scripted([{ text: "I can see the diagram." }]);
    await runAgent(
      userTurn("What does this diagram show?", {
        images: [
          {
            id: "img_1",
            mime: "image/png",
            url: "https://storage.example/img_1.png",
            alt: "architecture diagram",
          },
        ],
      }),
      { llm, agent: chatAgent },
    );

    const messages = llm.seen[0]?.messages ?? [];
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        images: [
          expect.objectContaining({ id: "img_1", mime: "image/png" }),
        ],
      }),
    );
  });
  it("carries image references from an inbox message into the next run", async () => {
    const inbox = new MemoryInboxStore();
    await inbox.push({
      id: "m1",
      channel: "thread",
      text: "Now compare it to this.",
      delivery: "queue",
      images: [
        {
          id: "img_2",
          mime: "image/jpeg",
          url: "https://storage.example/img_2.jpg",
        },
      ],
    });
    const llm = scripted([{ text: "first" }, { text: "second" }]);
    await runAgent(
      userTurn("start"),
      { llm, agent: chatAgent, inbox: { store: inbox, channel: "thread" } },
    );
    const second = llm.seen[1]?.messages.at(-1);
    expect(second).toMatchObject({
      role: "user",
      images: [expect.objectContaining({ id: "img_2", mime: "image/jpeg" })],
    });
  });

});
