/**
 * run_tests — first-class test runner (not just bash).
 *
 * Being its own tool means test status is structured data in the trace (the
 * verify phase gates on it), the timeout defaults suit slow suites, and a
 * failing run gets a summary line the model can reason about.
 *
 * Command resolution: explicit `command` → ctx.testCommand (from the task
 * spec) → repo auto-detection (package.json/pytest/Makefile).
 */
import { spillOrTruncate } from "./truncate.js";
import {
  defineTool,
  formatExec,
  optionalNumber,
  optionalString,
  requireSandbox,
  type ToolContext,
} from "./types.js";

const DETECT =
  `if [ -f package.json ] && grep -q '"test"' package.json; then ` +
  `if command -v npm >/dev/null 2>&1; then echo "npm test"; else echo "bun run test"; fi; ` +
  `elif [ -f pyproject.toml ] || [ -f pytest.ini ] || [ -f setup.py ]; then echo "pytest -q"; ` +
  `elif [ -f Makefile ]; then echo "make test"; ` +
  `else echo "none"; fi`;

/**
 * Best-effort working-tree content hash (decision #38). Checks recompute the
 * same hash through the sandbox to prove a recorded green run still applies
 * to the current tree — no suite re-run needed. Empty output = no git → the
 * hash is omitted and checks fall back to pure evidence.
 */
const TREE_HASH_CMD =
  "git add -A >/dev/null 2>&1; git write-tree 2>/dev/null || true";

interface ResolvedCommand {
  command: string;
  /**
   * true when the command came from the task spec or repo detection — i.e.
   * the repo's canonical full suite. An explicit per-call `command` is a
   * targeted run and must not count as full-suite evidence.
   */
  defaultCommand: boolean;
}

async function resolveCommand(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ResolvedCommand | null> {
  const explicit = optionalString(input, "command");
  if (explicit) return { command: explicit, defaultCommand: false };
  if (ctx.testCommand)
    return { command: ctx.testCommand, defaultCommand: true };
  const probe = await requireSandbox(ctx).exec(DETECT, { timeoutSecs: 60 });
  const detected = probe.stdout.trim();
  return detected === "" || detected === "none"
    ? null
    : { command: detected, defaultCommand: true };
}

export const runTestsTool = defineTool(
  {
    name: "run_tests",
    description:
      "Run the repository's test suite (or an explicit command). Returns the test " +
      "output and a real exit status — use this to reproduce failures and to verify fixes.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Override the test command (e.g. a single test file).",
        },
        timeout_secs: {
          type: "integer",
          description: "Kill deadline in seconds (default 600, max 3600).",
        },
      },
      additionalProperties: false,
    },
  },
  async (input, ctx) => {
    const resolved = await resolveCommand(input, ctx);
    if (!resolved) {
      return {
        ok: false,
        content:
          'no test command detected — call run_tests with an explicit command (e.g. "npm test", "pytest -q tests/").',
        meta: {},
      };
    }
    const { command, defaultCommand } = resolved;
    const timeoutSecs = Math.max(
      1,
      Math.min(3600, optionalNumber(input, "timeout_secs", 600)),
    );
    const sandbox = requireSandbox(ctx);
    const r = await sandbox.exec(command, { timeoutSecs });
    // Freshness evidence: the tree hash at this moment. Checks compare it at
    // move time — "green" only counts if the tree still matches (decision #38).
    const tree = await sandbox.exec(TREE_HASH_CMD, { timeoutSecs: 60 });
    const treeHash = /^[0-9a-f]{40}$/.test(tree.stdout.trim())
      ? tree.stdout.trim()
      : undefined;
    return {
      ok: r.exitCode === 0 && !r.timedOut,
      content: await spillOrTruncate(
        `run_tests: ${command}\n${formatExec(r, timeoutSecs)}`,
        { sandbox: ctx.sandbox, label: "run_tests" },
      ),
      // `ran: true` distinguishes "the suite executed and failed" from "no
      // test command found"; `defaultCommand` distinguishes the repo's full
      // suite from a targeted run — strategies gate evidence on both.
      meta: {
        command,
        ran: true,
        defaultCommand,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        ...(r.failure ? { failure: r.failure } : {}),
        ...(treeHash !== undefined ? { treeHash } : {}),
      },
    };
  },
);
