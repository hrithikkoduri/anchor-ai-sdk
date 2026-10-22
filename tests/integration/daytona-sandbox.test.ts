import { describe } from "vitest";
import { daytona } from "../../src/sandbox/daytona/index.js";
import { runSandboxConformance } from "../../src/testing.js";

/**
 * Live Daytona conformance. Opt-in: a provider outage or missing credentials
 * must not read as a red build.
 *
 *   DAYTONA_API_KEY=... DAYTONA_IMAGE=debian:12 \
 *     RUN_LIVE_DAYTONA_TESTS=1 npm test -- daytona-sandbox
 *
 * `DAYTONA_IMAGE` must be a registry Docker image containing bash, git, and
 * coreutils (`timeout`) — Daytona builds a snapshot from it at create time.
 * Optional: DAYTONA_API_URL / DAYTONA_TARGET for self-hosted or region pins.
 */
const enabled =
  process.env.RUN_LIVE_DAYTONA_TESTS === "1" &&
  !!process.env.DAYTONA_API_KEY &&
  !!process.env.DAYTONA_IMAGE;

if (enabled) {
  runSandboxConformance(
    daytona({
      apiKey: process.env.DAYTONA_API_KEY,
      ...(process.env.DAYTONA_API_URL
        ? { apiUrl: process.env.DAYTONA_API_URL }
        : {}),
      ...(process.env.DAYTONA_TARGET
        ? { target: process.env.DAYTONA_TARGET }
        : {}),
      image: process.env.DAYTONA_IMAGE,
      quiet: true,
    }),
    {
      timeoutMs: 240_000,
      repo: { repoUrl: "https://github.com/octocat/Hello-World.git" },
    },
  );
} else {
  describe.skip(
    "daytona conformance (set DAYTONA_API_KEY, DAYTONA_IMAGE, RUN_LIVE_DAYTONA_TESTS=1)",
    () => undefined,
  );
}
