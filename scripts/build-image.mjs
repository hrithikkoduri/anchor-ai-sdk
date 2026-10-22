/**
 * Build and publish a named machine image on any provider's own hub — the
 * "machine image" step every remote consumer needs once. The built name is
 * what `SandboxSpec.image` accepts on later `create`s (publish-then-boot).
 *
 *   node scripts/build-image.mjs --provider daytona \
 *     --name anchor-toolchain --from-image debian:bookworm \
 *     --run 'apt-get update' --run 'apt-get install -y git ripgrep'
 *
 *   node scripts/build-image.mjs --provider e2b --name anchor-toolchain ...
 *   node scripts/build-image.mjs --provider heyo --name anchor-toolchain \
 *     --git-repo https://github.com/org/repo --git-ref main
 *
 * Credentials come from each provider's environment (DAYTONA_API_KEY,
 * E2B_API_KEY, and heyo's server/token config via HEYO_* variables or a
 * .env file loaded with `node --env-file=.env`).
 */
import { readFileSync } from "node:fs";
import { daytona } from "../src/sandbox/daytona/index.js";
import { e2b } from "../src/sandbox/e2b/index.js";
import { heyo } from "../src/sandbox/heyo/index.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function runs() {
  const out = [];
  let i = 0;
  while (process.argv.indexOf("--run", i) !== -1) {
    const at = process.argv.indexOf("--run", i);
    out.push(process.argv[at + 1]);
    i = at + 1;
  }
  return out.filter(Boolean);
}

const providerName = arg("provider");
if (!providerName) {
  console.error(
    "usage: node scripts/build-image.mjs --provider daytona|e2b|heyo --name <name> [--from-image <ref> | --dockerfile <path>] [--run <cmd>]... [--git-repo <url> --git-ref <ref>]",
  );
  process.exit(1);
}

const env = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`missing ${name} — set it in the environment or .env`);
    process.exit(1);
  }
  return value;
};

const spec = {
  name: arg("name"),
  fromImage: arg("from-image"),
  dockerfile: arg("dockerfile"),
  run: runs(),
  gitRepo: arg("git-repo"),
  gitRef: arg("git-ref"),
  gitDockerfile: arg("git-dockerfile"),
};

let provider;
switch (providerName) {
  case "daytona":
    provider = daytona({});
    break;
  case "e2b":
    provider = e2b({});
    break;
  case "heyo": {
    // The heyo provider's config rides the consumer's own deployment setup;
    // the CLI reads the common envs so a machine can run it headless.
    provider = heyo({
      server: env("HEYO_SERVER"),
      token: env("HEYO_TOKEN"),
      namespace: env("HEYO_NAMESPACE"),
      image: env("HEYO_IMAGE"),
      imageStore: process.env.HEYO_IMAGE_STORE,
      imageKind: process.env.HEYO_IMAGE_KIND,
      sizeClass: process.env.HEYO_SIZE_CLASS ?? "small",
      diskSizeGb: Number(process.env.HEYO_DISK_GB ?? "20"),
    });
    break;
  }
  default:
    console.error(`unknown provider "${providerName}" — daytona|e2b|heyo`);
    process.exit(1);
}

if (!spec.name) {
  console.error("--name is required (the name later creates reference)");
  process.exit(1);
}

const health = await provider.probe();
if (!health.ok) {
  console.error(`provider ${providerName} is not reachable: ${health.detail}`);
  process.exit(1);
}

console.log(
  `building ${providerName} image "${spec.name}"` +
    `${spec.fromImage ? ` from ${spec.fromImage}` : ""}${spec.dockerfile ? ` from ${spec.dockerfile}` : ""}…`,
);
const built = await provider.buildImage(spec);
console.log(`built: ${built.name} (provider ${built.provider})`);
console.log(`later sandboxes boot it with: { image: "${built.name}" }`);
