/**
 * Build the E2B template the live conformance suite (and local smoke runs)
 * expect. E2B boots a template, not an arbitrary Docker image, so this is the
 * "machine image" step every consumer needs once.
 *
 *   E2B_API_KEY=... node scripts/build-e2b-template.mjs
 *   # or: node --env-file=.env scripts/build-e2b-template.mjs
 *
 * Override the name with E2B_TEMPLATE (default `anchor-conformance`) and the
 * size with E2B_CPU_COUNT / E2B_MEMORY_MB.
 */
import { Template, defaultBuildLogger } from "e2b";

const name = process.env.E2B_TEMPLATE ?? "anchor-conformance";
const cpuCount = Number(process.env.E2B_CPU_COUNT ?? 2);
const memoryMB = Number(process.env.E2B_MEMORY_MB ?? 2048);

const template = Template()
  .fromUbuntuImage("24.04")
  .runCmd([
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y --no-install-recommends git ca-certificates curl bash coreutils ripgrep",
    "rm -rf /var/lib/apt/lists/*",
    "git --version && timeout --version | head -1",
  ]);

console.log(
  `building E2B template "${name}" (${cpuCount} vCPU, ${memoryMB} MB)…`,
);
await Template.build(template, name, {
  cpuCount,
  memoryMB,
  onBuildLogs: defaultBuildLogger(),
});
console.log(`built "${name}" — use it as E2B_TEMPLATE=${name}`);
