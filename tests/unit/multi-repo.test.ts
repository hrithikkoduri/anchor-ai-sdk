import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chatAgent } from "../../src/agents/chat/index.js";
import { runAgent } from "../../src/engine/loop.js";
import { userTurn } from "../../src/engine/types.js";
import { validateRepos, repoForPath } from "../../src/repo.js";
import { bashTool } from "../../src/tools/bash.js";
import { editFileTool } from "../../src/tools/edit-file.js";
import { runTestsTool } from "../../src/tools/run-tests.js";
import { defineTool, type Tool } from "../../src/tools/types.js";
import { configsForRepo } from "../../src/lsp/tools.js";
import { typescriptLanguageServer } from "../../src/lsp/typescript.js";
import { local } from "../../src/sandbox/local/index.js";
import type { Sandbox } from "../../src/sandbox/types.js";
import { scripted } from "../helpers/scripted.js";

const roots: string[] = [];
const repos = [
  { name: "acme/api", path: "api" },
  { name: "acme/web", path: "web" },
];

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "anchor-multi-repo-"));
  roots.push(root);
  const box = local({ rootDir: root, quiet: true }).create({});
  await box.start();
  await box.exec("mkdir -p api/src web/src");
  return box;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("repo references", () => {
  it("resolves paths and rejects escaping/absolute paths", () => {
    expect(() => validateRepos(repos, "/workspace")).not.toThrow();
    expect(() =>
      validateRepos([{ name: "x", path: "../x" }], "/workspace"),
    ).toThrow(/must not contain/);
    expect(() =>
      validateRepos([{ name: "x", path: "/x" }], "/workspace"),
    ).toThrow(/relative/);
    expect(() =>
      validateRepos([{ name: "x", path: "api/../web" }], "/workspace"),
    ).toThrow(/must not contain/);
    expect(repoForPath(repos, "api/src/x.ts", "/workspace")?.name).toBe(
      "acme/api",
    );
    expect(repoForPath(repos, "web/README.md", "/workspace")?.name).toBe(
      "acme/web",
    );
    expect(repoForPath(repos, "other/x", "/workspace")).toBeUndefined();
  });

  it("selects the longest matching repo path", () => {
    const nested = [
      { name: "root", path: "." },
      { name: "api", path: "api" },
    ];
    expect(repoForPath(nested, "api/src/x.ts", "/workspace")?.name).toBe("api");
    expect(repoForPath(nested, "README.md", "/workspace")?.name).toBe("root");
  });
});

describe("repo-aware tools", () => {
  it("runs bash in the named repository and rejects unknown repos", async () => {
    const box = await sandbox();
    try {
      const context = { sandbox: box, repos };
      const result = await bashTool.run(
        { command: "pwd", repository: "acme/api" },
        context,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toContain("/api");
      expect(result.meta).toMatchObject({ repository: "acme/api" });

      const unknown = await bashTool.run(
        { command: "pwd", repository: "acme/nope" },
        context,
      );
      expect(unknown.ok).toBe(false);
      expect(unknown.content).toContain('unknown repository "acme/nope"');
    } finally {
      await box.destroy();
    }
  });

  it("runs run_tests in the repo, hashes that repo tree, and requires a repo when multiple exist", async () => {
    const box = await sandbox();
    try {
      await box.exec(
        "cd api && git init -q && git config user.email test@example.com && git config user.name test && echo x > x.txt && git add x.txt",
      );
      const context = { sandbox: box, repos };
      const tool = runTestsTool();
      const result = await tool.run(
        { command: "pwd", repository: "acme/api" },
        context,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toContain("/api");
      expect(result.meta).toMatchObject({
        repository: "acme/api",
        ran: true,
      });
      expect(result.meta?.treeHash).toMatch(/^[0-9a-f]{40}$/);

      const missing = await tool.run({ command: "pwd" }, context);
      expect(missing.ok).toBe(false);
      expect(missing.content).toContain("needs a repository");
    } finally {
      await box.destroy();
    }
  });

  it("attributes edit_file resources by the longest path prefix", () => {
    const ctx = { sandbox: undefined, repos };
    expect(
      editFileTool.resource?.({ path: "api/src/x.ts" }, ctx),
    ).toBe("acme/api");
    expect(
      editFileTool.resource?.({ path: "web/src/x.ts" }, ctx),
    ).toBe("acme/web");
    expect(
      editFileTool.resource?.({ path: "README.md" }, ctx),
    ).toBeUndefined();
  });
});

function resourceWrite(
  name: string,
  counter: { current: number; max: number },
  opts: { effect?: boolean } = {},
): Tool {
  return defineTool(
    {
      name,
      description: "test mutation",
      parameters: { type: "object", properties: {} },
    },
    async () => {
      counter.current += 1;
      counter.max = Math.max(counter.max, counter.current);
      await new Promise((resolve) => setTimeout(resolve, 40));
      counter.current -= 1;
      return { ok: true, content: `${name} result` };
    },
    {
      ...(opts.effect ? { effect: {} } : {}),
      resource: (input) =>
        typeof input.repo === "string" ? input.repo : undefined,
    },
  );
}

async function runCalls(tools: Tool[], calls: Array<{ name: string; args: Record<string, unknown> }>) {
  const llm = scripted([
    {
      tools: calls.map((call) => ({
        name: call.name,
        arguments: JSON.stringify(call.args),
      })),
    },
    { text: "done" },
  ]);
  return runAgent(userTurn("run mutations"), {
    llm,
    agent: chatAgent,
    tools,
    budgets: { maxSteps: 5 },
  });
}

describe("resource dispatch", () => {
  it("runs different repository keys concurrently and preserves result order", async () => {
    const counter = { current: 0, max: 0 };
    const api = resourceWrite("write_api", counter);
    const web = resourceWrite("write_web", counter);
    const result = await runCalls(
      [api, web],
      [
        { name: "write_api", args: { repo: "api" } },
        { name: "write_web", args: { repo: "web" } },
      ],
    );
    expect(counter.max).toBe(2);
    const contents = result.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content);
    expect(contents).toEqual(["write_api result", "write_web result"]);
  });

  it("an ordinary call first does not serialize the fan-out after it; results keep call order", async () => {
    const counter = { current: 0, max: 0 };
    const order: string[] = [];
    const api = resourceWrite("write_api", counter);
    const web = resourceWrite("write_web", counter);
    const note = defineTool(
      { name: "note", description: "an ordinary call", parameters: { type: "object", properties: {} } },
      async () => {
        order.push("note");
        // The tail has not started while the opening runs.
        expect(counter.current).toBe(0);
        return { ok: true, content: "note result" };
      },
    );
    const result = await runCalls(
      [note, api, web],
      [
        { name: "note", args: {} },
        { name: "write_api", args: { repo: "api" } },
        { name: "write_web", args: { repo: "web" } },
      ],
    );
    expect(order).toEqual(["note"]);
    expect(counter.max).toBe(2);
    const contents = result.messages.filter((message) => message.role === "tool").map((message) => message.content);
    expect(contents).toEqual(["note result", "write_api result", "write_web result"]);
  });

  it("an opening that concludes the turn, or an ordinary call after the fan-out, keeps the turn serial", async () => {
    const counter = { current: 0, max: 0 };
    const api = resourceWrite("write_api", counter);
    const web = resourceWrite("write_web", counter);
    const note = defineTool({ name: "note", description: "an ordinary call", parameters: { type: "object", properties: {} } }, async () => ({ ok: true, content: "note result" }));
    await runCalls(
      [note, api, web],
      [
        { name: "write_api", args: { repo: "api" } },
        { name: "note", args: {} },
        { name: "write_web", args: { repo: "web" } },
      ],
    );
    expect(counter.max).toBe(1);
  });

  it("serializes calls for the same repository", async () => {
    const counter = { current: 0, max: 0 };
    const tool = resourceWrite("write_api", counter);
    await runCalls(
      [tool],
      [
        { name: "write_api", args: { repo: "api" } },
        { name: "write_api", args: { repo: "api" } },
      ],
    );
    expect(counter.max).toBe(1);
  });

  it("serializes calls with no repository key", async () => {
    const counter = { current: 0, max: 0 };
    const root = resourceWrite("write_root", counter);
    await runCalls(
      [root],
      [
        { name: "write_root", args: {} },
        { name: "write_root", args: {} },
      ],
    );
    expect(counter.max).toBe(1);
  });

  it("serializes effectful calls even across repository keys", async () => {
    const counter = { current: 0, max: 0 };
    const effect = resourceWrite("write_effect", counter, { effect: true });
    await runCalls(
      [effect],
      [
        { name: "write_effect", args: { repo: "api" } },
        { name: "write_effect", args: { repo: "web" } },
      ],
    );
    expect(counter.max).toBe(1);
  });
});

describe("LSP repository roots", () => {
  it("creates a distinct server id and root URI per repo", () => {
    const server = typescriptLanguageServer();
    const configs = configsForRepo([server], { name: "acme/api", path: "api" }, "/workspace");
    expect(configs[0]?.id).toBe("typescript:acme/api");
    expect(configs[0]?.rootUri).toContain("/workspace/api");
  });
});
