/**
 * `createAnchor` — a small composition helper for applications that reuse one
 * model, agent, sandbox, and thread across many runs. It is intentionally not
 * a second engine: every call still goes through `runAgent`.
 */
import { runAgent } from "./engine/loop.js";
import type {
  AgentResult,
  EngineOptions,
  RunInput,
} from "./engine/types.js";
import { userTurn } from "./engine/types.js";
import type { Agent } from "./agents/types.js";
import type { LLMClient } from "./llm/types.js";
import type { Sandbox } from "./sandbox/types.js";
import type { RepoRef } from "./repo.js";
import type { Tool } from "./tools/types.js";

export type AnchorDefaults = Omit<
  Partial<EngineOptions>,
  "llm" | "agent" | "sandbox" | "tools" | "thread"
>;

export interface CreateAnchorOptions {
  llm: LLMClient;
  agent?: Agent;
  sandbox?: Sandbox;
  tools?: Tool[];
  repos?: RepoRef[];
  thread?: EngineOptions["thread"];
  /** Runtime options applied to every run; per-run overrides win. */
  defaults?: AnchorDefaults;
}

export interface AnchorDoctor {
  ok: boolean;
  model: string;
  agent: string;
  hasThread: boolean;
  sandbox?: {
    id: string;
    backend: string;
    workspace: string;
    reachable: boolean;
    error?: string;
  };
}

export interface Anchor {
  run(
    task: RunInput | string,
    overrides?: Partial<EngineOptions>,
  ): Promise<AgentResult>;
  /** Cheap configuration/connectivity check; does not start a sandbox. */
  doctor(): Promise<AnchorDoctor>;
}

export function createAnchor(options: CreateAnchorOptions): Anchor {
  const defaults = options.defaults ?? {};
  const run = async (
    task: RunInput | string,
    overrides: Partial<EngineOptions> = {},
  ): Promise<AgentResult> =>
    runAgent(typeof task === "string" ? userTurn(task) : task, {
      ...defaults,
      llm: options.llm,
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.repos ? { repos: options.repos } : {}),
      ...(options.thread ? { thread: options.thread } : {}),
      ...overrides,
    });

  const doctor = async (): Promise<AnchorDoctor> => {
    let sandbox: AnchorDoctor["sandbox"];
    if (options.sandbox) {
      try {
        const result = await options.sandbox.exec("true", {
          timeoutSecs: 5,
          concurrent: true,
        });
        sandbox = {
          id: options.sandbox.id,
          backend: options.sandbox.backend,
          workspace: options.sandbox.workspace,
          reachable: result.exitCode === 0,
          ...(result.exitCode === 0
            ? {}
            : { error: (result.stderr || result.output).trim() }),
        };
      } catch (error) {
        sandbox = {
          id: options.sandbox.id,
          backend: options.sandbox.backend,
          workspace: options.sandbox.workspace,
          reachable: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      ok: !!options.llm.model && (!sandbox || sandbox.reachable),
      model: options.llm.model,
      agent: options.agent?.name ?? "default",
      hasThread: !!options.thread,
      ...(sandbox ? { sandbox } : {}),
    };
  };

  return { run, doctor };
}
