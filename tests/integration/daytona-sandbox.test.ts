import { describe } from "vitest";
import { daytona } from "../../src/sandbox/daytona/index.js";
import { runSandboxConformance } from "../../src/testing.js";

/**
 * Live Daytona conformance. Opt-in: a provider outage or missing credentials
 * must not read as a red build.
 *
 *   DAYTONA_API_KEY=... DAYTONA_IMAGE=anchor-conformance \
 *     RUN_LIVE_DAYTONA_TESTS=1 npm test -- daytona-sandbox
 *
 * `DAYTONA_IMAGE` (or `DAYTONA_SNAPSHOT`) must contain bash, git, and coreutils
 * including `timeout`, and a shell user that can write the workspace. The
 * adapter does not assume a vendor default image has git.
 */
const enabled =
  process.env.RUN_LIVE_DAYTONA_TESTS === "1" &&
  !!process.env.DAYTONA_API_KEY &&
  !!(process.env.DAYTONA_IMAGE || process.env.DAYTONA_SNAPSHOT);

if (enabled) {
  runSandboxConformance(
    daytona({
      ...(process.env.DAYTONA_IMAGE
        ? { image: process.env.DAYTONA_IMAGE }
        : {}),
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
    "daytona conformance (set DAYTONA_API_KEY, DAYTONA_IMAGE or DAYTONA_SNAPSHOT, RUN_LIVE_DAYTONA_TESTS=1)",
    () => undefined,
  );
}
