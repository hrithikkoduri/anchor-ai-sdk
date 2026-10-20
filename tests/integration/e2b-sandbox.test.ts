import { describe } from "vitest";
import { e2b } from "../../src/sandbox/e2b/index.js";
import { runSandboxConformance } from "../../src/testing.js";

/**
 * Live E2B conformance. Opt-in: a provider outage or missing credentials must
 * not read as a red build.
 *
 *   E2B_API_KEY=... E2B_TEMPLATE=anchor-conformance \
 *     RUN_LIVE_E2B_TESTS=1 npm test -- e2b-sandbox
 *
 * `E2B_TEMPLATE` must contain bash, git, coreutils (`timeout`), and a shell
 * user that can write the workspace. The adapter does not assume the public
 * `base` template has git.
 */
const enabled =
  process.env.RUN_LIVE_E2B_TESTS === "1" &&
  !!process.env.E2B_API_KEY &&
  !!process.env.E2B_TEMPLATE;

if (enabled) {
  runSandboxConformance(
    e2b({ template: process.env.E2B_TEMPLATE, quiet: true }),
    {
      timeoutMs: 240_000,
      repo: { repoUrl: "https://github.com/octocat/Hello-World.git" },
    },
  );
} else {
  describe.skip(
    "e2b conformance (set E2B_API_KEY, E2B_TEMPLATE, RUN_LIVE_E2B_TESTS=1)",
    () => undefined,
  );
}
