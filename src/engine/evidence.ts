/**
 * Publication evidence — "green" only counts when it is green on THIS tree.
 *
 * The `run_tests` tool records the staged tree hash at the moment it ran
 * (decision #38: freshness evidence in `meta.treeHash`). This is the consumer
 * side of that contract: tie the LATEST observed test run to the exact bytes
 * a publication would ship, and fail closed when the tree cannot be
 * inspected. The producer lives in tools/run-tests.ts; the decision lives
 * here so every publication path asks the same question the same way.
 */
import type { Sandbox } from "../sandbox/types.js";
import type { AgentEvent } from "./events.js";

export type TreeVerification =
  | { inspected: false }
  | {
      inspected: true;
      treeHash: string;
      /**
       * passed        — a run_tests finished green on this exact tree
       * failed        — a run_tests finished red on this exact tree
       * not_verified  — no run, or the tree changed since the last one
       */
      verification: "passed" | "failed" | "not_verified";
    };

/**
 * Stage everything (`git add -A` — uncommitted work counts), hash the tree,
 * and find what the latest executed test run says about it. A hash that
 * cannot be produced is `inspected: false`, never "nothing to verify".
 */
export async function latestEvidenceForTree(
  sandbox: Sandbox,
  events: readonly AgentEvent[],
): Promise<TreeVerification> {
  const tree = await sandbox
    .exec("git add -A >/dev/null 2>&1 && git write-tree", { timeoutSecs: 60 })
    .catch(() => undefined);
  const treeHash = tree?.exitCode === 0 ? tree.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(treeHash)) return { inspected: false };

  const tests = [...events]
    .reverse()
    .find(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result" &&
        event.name === "run_tests" &&
        event.meta?.ran === true,
    );
  const fresh = tests?.meta?.treeHash === treeHash;
  const verification =
    fresh && tests?.ok
      ? "passed"
      : fresh && tests && !tests.ok
        ? "failed"
        : "not_verified";
  return { inspected: true, treeHash, verification };
}
