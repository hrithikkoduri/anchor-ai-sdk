import { describe } from "vitest";
import { daytona } from "../../src/sandbox/daytona/index.js";
import { runSandboxConformance } from "../../src/testing.js";

/**
 * Live Daytona conformance. Opt-in: a provider outage or missing credentials
 * must not read as a red build.
 *
 *   DAYTONA_API_KEY=... RUN_LIVE_DAYTONA_TESTS=1 \
 *     npm test -- daytona-sandbox
 *
 * `DAYTONA_SNAPSHOT` is optional; without it the account's default snapshot is
 * used, which ships bash, git, coreutils (`timeout`), python, and node.
 *
 * The fork scenario self-skips: this adapter declares `fork: false` because
 * Daytona answers 422 "Forking is not supported for this sandbox" for
 * container-class sandboxes. The process-stream scenarios skip for the same
 * declared reason (no stdin EOF; the PTY is an interactive shell).
 */
const enabled =
  process.env.RUN_LIVE_DAYTONA_TESTS === "1" && !!process.env.DAYTONA_API_KEY;

if (enabled) {
  runSandboxConformance(
    daytona({
      ...(process.env.DAYTONA_SNAPSHOT
        ? { snapshot: process.env.DAYTONA_SNAPSHOT }
        : {}),
      ...(process.env.DAYTONA_API_URL
        ? { apiUrl: process.env.DAYTONA_API_URL }
        : {}),
      ...(process.env.DAYTONA_TARGET
        ? { target: process.env.DAYTONA_TARGET }
        : {}),
      quiet: true,
    }),
    {
      timeoutMs: 300_000,
      repo: { repoUrl: "https://github.com/octocat/Hello-World.git" },
    },
  );
} else {
  describe.skip(
    "daytona conformance (set DAYTONA_API_KEY, RUN_LIVE_DAYTONA_TESTS=1)",
    () => undefined,
  );
}
