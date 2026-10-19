/**
 * The `mini-swe-agent` arm — the baseline harness, in the SAME sandbox as the
 * anchor arm: same image, same repo state, same model, same runner, same
 * patch extraction. That is the whole point: the A/B isolates the agent
 * design, not the environment.
 *
 * mini is embedded via its Python bindings (DefaultAgent + LitellmModel +
 * LocalEnvironment) rather than its CLI, so nothing of its own environment
 * management is in play. It is installed into a private venv inside the
 * container so its dependencies cannot disturb the task's environment.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { shq } from "anchor-ai-sdk";
import type { EvalArm, EvalArmContext } from "../runner.js";
import type { EvalTask } from "../tasks.js";

export interface MiniSweArmOptions {
  /** Provider API key — rides into the sandbox as an env var per exec. */
  apiKey?: string;
  /** litellm model id including provider, e.g. `openrouter/z-ai/glm-5.3`. */
  model: string;
  /** mini's own spend cap (USD). Default 2. */
  costLimitUsd?: number;
  /** Docker CLI for carrying the trajectory out (docker backend only). */
  dockerBin?: string;
}

/** The python driver: run one task in the current directory, print the result.
 * Mirrors mini's own swebench runner: its battle-tested templates come from
 * the packaged swebench.yaml; mode yolo + confirm_exit false = non-interactive. */
const DRIVER = `import sys
from minisweagent.agents import get_agent
from minisweagent.config import builtin_config_dir, get_config_from_spec
from minisweagent.environments.local import LocalEnvironment
from minisweagent.models import get_model
from minisweagent.utils.serialize import recursive_merge

task = open(sys.argv[1], encoding="utf-8").read()
config = recursive_merge(
    get_config_from_spec(str(builtin_config_dir / "benchmarks" / "swebench.yaml")),
    {
        "agent": {
            "mode": "yolo",
            "confirm_exit": False,
            "output_path": "/tmp/mini-traj.json",
        },
        "model": {"model_name": sys.argv[2]},
    },
)
agent = get_agent(
    get_model(config=config.get("model", {})),
    LocalEnvironment(),
    config.get("agent", {}),
    default_type="default",
)
agent.run(task)
print("MINI_DONE")
`;

/**
 * The install line, idempotent by design: `scripts/prewarm-mini-images.mjs`
 * runs the exact same command inside each task image and COMMITS the result
 * as `<repo>:mini-eval`, so eval runs boot a prewarmed image and skip the
 * (emulated, ~8-minute) install entirely.
 *
 * `litellm==1.106.0` is pinned to the version validated on the host — the
 * container's resolution otherwise picks a build whose import chain needs
 * `mcp`, which is not a declared dependency (hence `mcp` too, as insurance).
 */
export const MINI_INSTALL_COMMAND =
  "/opt/mini-venv/bin/python -c 'import minisweagent' 2>/dev/null || " +
  "{ python -m venv /opt/mini-venv && /opt/mini-venv/bin/pip install --quiet mini-swe-agent 'litellm==1.106.0' mcp; }";

/** Carry mini's trajectory out of the container before it is destroyed. */
async function captureTrajectory(
  ctx: EvalArmContext,
  task: EvalTask,
  opts: MiniSweArmOptions,
): Promise<{ steps?: number }> {
  if (!ctx.artifactsDir || ctx.sandbox.backend !== "docker") return {};
  await mkdir(ctx.artifactsDir, { recursive: true });
  const dest = `${ctx.artifactsDir}/mini-${task.id}.json`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      opts.dockerBin ?? "docker",
      ["cp", `${ctx.sandbox.id}:/tmp/mini-traj.json`, dest],
      { stdio: "ignore" },
    );
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`docker cp exited ${code}`)),
    );
    child.on("error", reject);
  });
  // Trajectory info carries mini's own accounting (api_calls, cost).
  try {
    const info =
      (
        JSON.parse(await readFile(dest, "utf8")) as {
          info?: { model_stats?: { api_calls?: unknown } };
        }
      ).info ?? {};
    const calls = info.model_stats?.api_calls;
    return typeof calls === "number" ? { steps: calls } : {};
  } catch {
    return {};
  }
}

export function miniSweArm(opts: MiniSweArmOptions): EvalArm {
  return {
    name: "mini-swe-agent",
    async run(task: EvalTask, ctx: EvalArmContext) {
      const writeFile = async (path: string, content: string) => {
        const encoded = Buffer.from(content, "utf8").toString("base64");
        const r = await ctx.sandbox.exec(
          `printf %s ${shq(encoded)} | base64 -d > ${shq(path)}`,
          { cwd: "/", timeoutSecs: 60 },
        );
        if (r.exitCode !== 0) {
          throw new Error(`could not write ${path}: ${r.output.trim()}`);
        }
      };
      await writeFile("/tmp/mini-task.md", task.problem);
      await writeFile("/tmp/mini-driver.py", DRIVER);

      // `env -u PYTHONPATH`: the task env now puts /testbed ahead of
      // site-packages (tasks.ts), which the anchor arm needs. The baseline arm
      // must stay byte-identical, so its own venv tooling opts out — a repo on
      // sys.path can otherwise shadow a dependency while pip/venv run.
      const install = await ctx.sandbox.exec(
        `env -u PYTHONPATH bash -c ${shq(MINI_INSTALL_COMMAND)}`,
        {
          cwd: "/",
          timeoutSecs: 1800,
        },
      );
      if (install.exitCode !== 0) {
        throw new Error(
          `mini-swe-agent install failed: ${install.output.trim().slice(0, 400)}`,
        );
      }

      let stats: { steps?: number } = {};
      try {
        const run = await ctx.sandbox.exec(
          `env -u PYTHONPATH /opt/mini-venv/bin/python /tmp/mini-driver.py /tmp/mini-task.md ${shq(opts.model)}`,
          {
            cwd: ctx.sandbox.workspace,
            timeoutSecs: 3600,
            env: {
              MSWEA_GLOBAL_COST_LIMIT: String(opts.costLimitUsd ?? 2),
              // litellm's price registry does not know openrouter/z-ai/glm-5.3
              // and its cost tracking throws; ignore_errors keeps runs alive
              // (cost then comes from the grader-side accounting, not mini).
              MSWEA_COST_TRACKING: "ignore_errors",
              ...(opts.apiKey ? { OPENROUTER_API_KEY: opts.apiKey } : {}),
            },
          },
        );
        // A non-zero exit means the harness itself failed to run — the system
        // under test failing to launch is a failure, not an empty patch — so
        // surface its output tail instead of swallowing it.
        if (run.exitCode !== 0) {
          throw new Error(
            `mini run exited ${run.exitCode}: ${run.output.trim().slice(-500)}`,
          );
        }
      } finally {
        // mini writes its trajectory INSIDE the container — carry it out
        // before the runner destroys the sandbox (best-effort).
        stats = await captureTrajectory(ctx, task, opts).catch(() => ({}));
      }
      return stats;
    },
  };
}
