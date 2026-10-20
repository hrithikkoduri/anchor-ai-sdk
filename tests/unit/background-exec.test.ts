import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import type { AgentEvent } from "../../src/engine/events.js";
import { bashTool } from "../../src/tools/bash.js";
import { defineTool } from "../../src/tools/types.js";
import { chatAgent } from "../../src/agents/chat/index.js";
import type { ExecResult, Sandbox } from "../../src/sandbox/types.js";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";

const completed = (code = 0, stdout = "done\n"): ExecResult => ({
  exitCode: code,
  stdout,
  stderr: "",
  output: stdout,
  timedOut: false,
  durationMs: 10,
});

const backgrounded: ExecResult = {
  exitCode: -1,
  stdout: "",
  stderr: "",
  output: "still running",
  timedOut: false,
  durationMs: 5_000,
  background: { jobId: "/tmp/anchor-exec-abc" },
};

/** The smallest sandbox that satisfies exec + background polling. */
function fakeSandbox(
  exec: Sandbox["exec"],
  poll: Sandbox["pollJob"] = async () => undefined,
): Sandbox {
  return {
    id: "sb-test",
    backend: "fake",
    workspace: "/workspace/repo",
    scratch: "/workspace/.anchor",
    start: async () => undefined,
    exec,
    pollJob: poll,
    killJob: async () => true,
    checkpoint: async () => ({ sha: "0".repeat(40), message: "", at: 0 }),
    hasChangesFrom: async () => false,
    fork: async () => {
      throw new Error("not supported");
    },
    destroy: async () => undefined,
  };
}

describe("bash background detach", () => {
  it("hands a long command to the harness at the threshold", async () => {
    const seen: Array<{ command: string; timeoutSecs?: number; threshold?: number }> =
      [];
    const sandbox = fakeSandbox(async (command, opts) => {
      seen.push({
        command,
        timeoutSecs: opts?.timeoutSecs,
        threshold: opts?.backgroundAfterSecs,
      });
      return opts?.backgroundAfterSecs ? backgrounded : completed();
    });
    const result = await bashTool.run(
      { command: "sleep 300" },
      { sandbox, backgroundAfterSecs: 120 },
    );
    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/moved to the background/);
    expect(result.content).toMatch(/Do NOT run it again/);
    expect(result.meta?.background).toEqual({ jobId: "/tmp/anchor-exec-abc" });
    // Unset model deadline → the job's hard lifetime is the tool max, and the
    // detach threshold is the consumer's number.
    expect(seen).toEqual([
      { command: "sleep 300", timeoutSecs: 3600, threshold: 120 },
    ]);
  });

  it("keeps an explicit short deadline synchronous", async () => {
    const seen: Array<{ timeoutSecs?: number; threshold?: number }> = [];
    const sandbox = fakeSandbox(async (_command, opts) => {
      seen.push({ timeoutSecs: opts?.timeoutSecs, threshold: opts?.backgroundAfterSecs });
      return completed(1, "boom\n");
    });
    const result = await bashTool.run(
      { command: "flaky", timeout_secs: 30 },
      { sandbox, backgroundAfterSecs: 120 },
    );
    expect(result.ok).toBe(false);
    expect(seen).toEqual([{ timeoutSecs: 30, threshold: undefined }]);
  });

  it("stays synchronous when the host did not opt in", async () => {
    const seen: Array<{ timeoutSecs?: number; threshold?: number }> = [];
    const sandbox = fakeSandbox(async (_command, opts) => {
      seen.push({ timeoutSecs: opts?.timeoutSecs, threshold: opts?.backgroundAfterSecs });
      return completed();
    });
    await bashTool.run({ command: "ls" }, { sandbox });
    expect(seen).toEqual([{ timeoutSecs: 120, threshold: undefined }]);
  });
});

describe("engine background delivery", () => {
  it("injects a finished job as a hidden runtime message", async () => {
    const requests: LLMRequest[] = [];
    const responses: Array<{ text: string; calls: LLMResponse["toolCalls"] }> = [
      { text: "", calls: [{ id: "call-1", name: "bg", arguments: "{}" }] },
      { text: "continuing", calls: [] },
      { text: "done", calls: [] },
    ];
    const llm: LLMClient = {
      model: "scripted",
      complete: async () => {
        throw new Error("unexpected compaction");
      },
      stream: async (request: LLMRequest) => {
        requests.push(structuredClone(request));
        const turn = responses.shift();
        if (!turn) throw new Error("out of scripted responses");
        return {
          text: turn.text,
          toolCalls: turn.calls,
          model: "scripted",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          latencyMs: 1,
        } satisfies LLMResponse;
      },
    };
    const events: AgentEvent[] = [];
    const bg = defineTool(
      {
        name: "bg",
        description: "starts a long command",
        parameters: { type: "object", properties: {} },
      },
      async () => ({
        ok: true,
        content: "moved to the background",
        meta: {
          background: { jobId: "job-1" },
          command: "npm test",
          timeoutSecs: 60,
        },
      }),
    );
    const sandbox = fakeSandbox(async () => completed(), async () =>
      completed(0, "all tests passed\n"),
    );

    const outcome = await runAgent(
      { task: "run the suite" },
      {
        llm,
        agent: chatAgent,
        sandbox,
        tools: [bg],
        onEvent: (event) => events.push(event),
      },
    );

    expect(outcome.ok).toBe(true);
    expect(
      events.find((e) => e.type === "background_completed"),
    ).toMatchObject({
      type: "background_completed",
      jobId: "job-1",
      tool: "bg",
      exitCode: 0,
      timedOut: false,
    });
    // The next call carries the result as a runtime-only message.
    const injected = requests[1]!.messages.find(
      (m) => m.origin === "runtime" && m.content?.includes("job-1"),
    );
    expect(injected?.content).toContain("npm test");
    expect(injected?.content).toContain("all tests passed");
    expect(outcome.pendingJobs).toBeUndefined();
  });

  it("waits for a job the model tries to finish behind, then continues", async () => {
    const requests: LLMRequest[] = [];
    const responses: Array<{ text: string; calls: LLMResponse["toolCalls"] }> = [
      { text: "", calls: [{ id: "call-1", name: "bg", arguments: "{}" }] },
      { text: "I'm done", calls: [] }, // tried to finish; job still running
      { text: "now I'm done", calls: [] }, // after the injected result
    ];
    const llm: LLMClient = {
      model: "scripted",
      complete: async () => {
        throw new Error("unexpected compaction");
      },
      stream: async (request: LLMRequest) => {
        requests.push(structuredClone(request));
        const turn = responses.shift();
        if (!turn) throw new Error("out of scripted responses");
        return {
          text: turn.text,
          toolCalls: turn.calls,
          model: "scripted",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          latencyMs: 1,
        } satisfies LLMResponse;
      },
    };
    let polls = 0;
    const sandbox = fakeSandbox(
      async () => completed(),
      async () => {
        polls++;
        return polls >= 2 ? completed(0, "late output\n") : undefined;
      },
    );
    const bg = defineTool(
      {
        name: "bg",
        description: "starts a long command",
        parameters: { type: "object", properties: {} },
      },
      async () => ({
        ok: true,
        content: "moved to the background",
        meta: {
          background: { jobId: "job-wait" },
          command: "npm test",
          timeoutSecs: 5,
        },
      }),
    );

    const outcome = await runAgent(
      { task: "run the suite" },
      { llm, agent: chatAgent, sandbox, tools: [bg] },
    );

    // The run waited (more than the single boundary poll) and did not end at
    // the first "done".
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.messages.some((m) => m.content?.includes("late output"))).toBe(
      true,
    );
    expect(outcome.pendingJobs).toBeUndefined();
    expect(outcome.summary).toBe("now I'm done");
  });

  it("gives up on a job past its deadline instead of hanging the run", async () => {
    let polls = 0;
    const requests: LLMRequest[] = [];
    const responses: Array<{ text: string; calls: LLMResponse["toolCalls"] }> = [
      { text: "done", calls: [] },
      { text: "done again", calls: [] },
    ];
    const llm: LLMClient = {
      model: "scripted",
      complete: async () => {
        throw new Error("unexpected compaction");
      },
      stream: async (request: LLMRequest) => {
        requests.push(structuredClone(request));
        const turn = responses.shift();
        if (!turn) throw new Error("out of scripted responses");
        return {
          text: turn.text,
          toolCalls: turn.calls,
          model: "scripted",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          latencyMs: 1,
        } satisfies LLMResponse;
      },
    };
    const sandbox = fakeSandbox(
      async () => completed(),
      async () => {
        polls++;
        return undefined;
      },
    );

    const outcome = await runAgent(
      { task: "resume" },
      {
        llm,
        agent: chatAgent,
        sandbox,
        // Started long ago with a 1s lifetime: already past its deadline.
        resumeJobs: [{ jobId: "job-old", tool: "bash", startedAt: 0, timeoutSecs: 1 }],
      },
    );

    // One poll round, then the deadline check drops it — no sleep loop. The
    // note rides the FIRST call of the resumed run, before the model speaks.
    // One at the top of the resumed turn, one in the finish wait: the point is
    // that it does not sleep-loop, not the exact count.
    expect(polls).toBeLessThanOrEqual(2);
    expect(
      requests.some((request) =>
        request.messages.some((m) => m.content?.includes("no longer readable")),
      ),
    ).toBe(true);
    expect(outcome.pendingJobs).toBeUndefined();
    expect(outcome.ok).toBe(true);
  });

  it("reports a job it could not settle as pending instead of waiting forever", async () => {
    const responses: Array<{ text: string; calls: LLMResponse["toolCalls"] }> = [
      { text: "", calls: [{ id: "call-1", name: "bg", arguments: "{}" }] },
      { text: "done", calls: [] },
    ];
    const llm: LLMClient = {
      model: "scripted",
      complete: async () => {
        throw new Error("unexpected compaction");
      },
      stream: async () => {
        const turn = responses.shift();
        if (!turn) throw new Error("out of scripted responses");
        return {
          text: turn.text,
          toolCalls: turn.calls,
          model: "scripted",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          latencyMs: 1,
        } satisfies LLMResponse;
      },
    };
    const bg = defineTool(
      {
        name: "bg",
        description: "starts a long command",
        parameters: { type: "object", properties: {} },
      },
      async () => ({
        ok: true,
        content: "moved to the background",
        meta: { background: { jobId: "job-2" }, command: "sleep 300" },
      }),
    );
    // No sandbox: nothing can poll, so the run must not hang.
    const outcome = await runAgent(
      { task: "start it" },
      { llm, agent: chatAgent, tools: [bg] },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.pendingJobs?.map((j) => j.jobId)).toEqual(["job-2"]);
  });

  it("emits background_started with the job handle", async () => {
    const responses: Array<{
      text: string;
      calls: LLMResponse["toolCalls"];
    }> = [
      {
        text: "",
        calls: [{ id: "call-1", name: "bg", arguments: "{}" }],
      },
      { text: "continuing while it runs", calls: [] },
    ];
    const llm: LLMClient = {
      model: "scripted",
      complete: async () => {
        throw new Error("unexpected compaction");
      },
      stream: async (_request: LLMRequest) => {
        const turn = responses.shift();
        if (!turn) throw new Error("out of scripted responses");
        return {
          text: turn.text,
          toolCalls: turn.calls,
          model: "scripted",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          latencyMs: 1,
        } satisfies LLMResponse;
      },
    };
    const events: AgentEvent[] = [];
    const bg = defineTool(
      {
        name: "bg",
        description: "starts a long command",
        parameters: { type: "object", properties: {} },
      },
      async () => ({
        ok: true,
        content: "moved to the background",
        meta: { background: { jobId: "/tmp/anchor-exec-xyz" }, command: "sleep 300" },
      }),
    );
    const outcome = await runAgent(
      { task: "start the repro" },
      {
        llm,
        agent: chatAgent,
        tools: [bg],
        backgroundAfterSecs: 120,
        onEvent: (event) => events.push(event),
      },
    );
    expect(outcome.ok).toBe(true);
    const started = events.find((e) => e.type === "background_started");
    expect(started).toMatchObject({
      type: "background_started",
      jobId: "/tmp/anchor-exec-xyz",
      tool: "bg",
      command: "sleep 300",
    });
  });
});
