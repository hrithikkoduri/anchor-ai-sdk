import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import { chatAgent } from "../../src/agents/chat/index.js";
import { codingAgent } from "../../src/agents/coding/index.js";
import { runAgent } from "../../src/engine/loop.js";
import { scaffoldBuggyLib } from "../helpers/buggy-lib.js";
import { scripted } from "../helpers/scripted.js";
import { userTurn } from "../../src/engine/types.js";

/** The phase block is intrinsic: the engine appends it, the strategy does
 * not provide it, and the same `intrinsics.phase` switch governs the tool. */
describe("phase discipline", () => {
  let sandbox: LocalSandbox;
  let fixtureDir: string;
  beforeEach(async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), "anchor-phases-"));
    await scaffoldBuggyLib(fixtureDir);
    sandbox = new LocalSandbox({ localPath: fixtureDir }, { quiet: true });
    await sandbox.start();
  });
  afterEach(async () => {
    await sandbox.destroy();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("appends the intrinsic block to a multi-phase strategy", async () => {
    const llm = scripted([{ text: "No changes." }]);
    await runAgent(
      userTurn("Explain the code"),
      { llm, sandbox, agent: codingAgent },
    );
    const system = llm.seen[0]!.messages[0]!;
    expect(system.role).toBe("system");
    expect(system.content).toContain("## Staying on phase");
    expect(system.content).toContain("Keep the phase true");
    expect(system.content).toContain(
      "Your phases: understand, plan, act, validate, respond",
    );
  });

  it("registers set_phase as a focus/intent tool, without permission framing", async () => {
    const llm = scripted([{ text: "No changes." }]);
    await runAgent(
      userTurn("Explain the code"),
      { llm, sandbox, agent: codingAgent },
    );
    const tool = llm.seen[0]!.tools?.find((item) => item.function.name === "set_phase");
    expect(tool).toBeDefined();
    expect(tool!.function.description).toContain("keeps you focused");
    expect(tool!.function.description).not.toContain("does not authorize");
    expect(tool!.function.description).not.toContain("without calling this tool");
  });

  it("switches the block and the tool off together", async () => {
    const llm = scripted([{ text: "No changes." }]);
    await runAgent(
      userTurn("Explain the code"),
      { llm, sandbox, agent: codingAgent, intrinsics: { phase: false } },
    );
    expect(llm.seen[0]!.messages[0]!.content).not.toContain("Staying on phase");
    expect(llm.seen[0]!.tools?.some((tool) => tool.function.name === "set_phase")).toBe(
      false,
    );
  });

  it("stays out of a single-phase strategy", async () => {
    const llm = scripted([{ text: "Understood." }]);
    await runAgent(userTurn("Say hi"), { llm, agent: chatAgent });
    expect(llm.seen[0]!.messages[0]!.content).not.toContain("Staying on phase");
    expect(llm.seen[0]!.tools?.some((tool) => tool.function.name === "set_phase")).toBe(
      false,
    );
  });
});
