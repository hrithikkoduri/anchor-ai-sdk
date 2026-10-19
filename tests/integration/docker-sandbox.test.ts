/**
 * Docker provider conformance — real containers.
 *
 * Opt-in: needs a Docker daemon and an image with bash + git + coreutils
 * (any toolchain image you already have):
 *
 *   ANCHOR_DOCKER_TEST_IMAGE=<your-image> \
 *     npm test -w packages/core -- docker-sandbox
 *
 * Docker Desktop on macOS is not on PATH by default; point ANCHOR_DOCKER_BIN
 * at the CLI when needed. Skips silently when either is missing.
 */
import { spawnSync } from "node:child_process";
import { describe } from "vitest";
import { docker } from "../../src/sandbox/docker.js";
import { runSandboxConformance } from "../../src/testing.js";

const image = process.env.ANCHOR_DOCKER_TEST_IMAGE;
const dockerBin = process.env.ANCHOR_DOCKER_BIN ?? "docker";
const available =
  spawnSync(dockerBin, ["info"], { stdio: "ignore" }).status === 0;

describe.skipIf(!image || !available)(
  "docker sandbox conformance (live)",
  () => {
    runSandboxConformance(docker({ image, dockerBin }), { timeoutMs: 120_000 });
  },
);
