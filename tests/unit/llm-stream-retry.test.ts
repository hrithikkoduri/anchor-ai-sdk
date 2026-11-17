/**
 * A stream that dies mid-flight is the same call made again: a connection cut
 * part-way through an answer, or one that goes silent, is retried up to
 * `streamRetries` times, because nothing has acted on an answer that never
 * finished. The caller's own abort is never retried, and a stream that keeps
 * dying fails with what cut it. Mocked fetch; no network.
 */
import { describe, expect, it } from "vitest";
import { OpenAICompatibleClient, StreamDroppedError } from "../../src/llm/openai-compatible.js";

const encoder = new TextEncoder();
const frame = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
const text = (content: string) => frame({ choices: [{ delta: { content } }] });
const done = [frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }), encoder.encode("data: [DONE]\n\n")];

/** A response that sends `chunks`, then ends as `end` says: finished, cut, or silent until aborted. */
function streamed(chunks: Uint8Array[], end: "finish" | "cut" | "silent", signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (end === "finish") controller.close();
      // A real drop comes after what was already sent has been read.
      if (end === "cut") setTimeout(() => controller.error(new TypeError("terminated")), 5);
      if (end === "silent") signal?.addEventListener("abort", () => controller.error(signal.reason ?? new Error("aborted")));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const client = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  new OpenAICompatibleClient({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m", fetchImpl, retryBaseDelayMs: 1, ...over });

describe("a stream that dies mid-flight", () => {
  it("is made again after the connection is cut part-way, and the finished answer is the second one", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => (++calls === 1 ? streamed([text("half an ans")], "cut") : streamed([text("the answer"), ...done], "finish"));
    const deltas: string[] = [];
    const response = await client(fetchImpl).stream({ messages: [{ role: "user", content: "q" }] }, (delta) => deltas.push(delta));
    expect(calls).toBe(2);
    expect(response.text).toBe("the answer");
    expect(deltas).toEqual(["half an ans", "the answer"]);
  });

  it("is made again when it goes silent for longer than streamIdleMs", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => (++calls === 1 ? streamed([text("thinking")], "silent", init?.signal) : streamed([text("ok"), ...done], "finish"));
    const response = await client(fetchImpl, { streamIdleMs: 40 }).complete({ messages: [{ role: "user", content: "q" }] });
    expect(calls).toBe(2);
    expect(response.text).toBe("ok");
  });

  it("fails with what cut it once its retries are spent", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return streamed([text("x")], "cut");
    };
    await expect(client(fetchImpl, { streamRetries: 2 }).complete({ messages: [{ role: "user", content: "q" }] })).rejects.toThrow(StreamDroppedError);
    await expect(client(fetchImpl, { streamRetries: 0 }).complete({ messages: [{ role: "user", content: "q" }] })).rejects.toThrow(/terminated/);
    expect(calls).toBe(4);
  });

  it("never retries the caller's own abort", async () => {
    let calls = 0;
    const caller = new AbortController();
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++;
      setTimeout(() => caller.abort(new Error("cancelled by the caller")), 10);
      return streamed([text("x")], "silent", init?.signal);
    };
    await expect(client(fetchImpl, { streamIdleMs: 5_000 }).complete({ messages: [{ role: "user", content: "q" }] }, { signal: caller.signal })).rejects.toThrow(/cancelled by the caller/);
    expect(calls).toBe(1);
  });
});
