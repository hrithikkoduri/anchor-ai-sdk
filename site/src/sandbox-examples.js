// Configuration examples target published SDK 0.1.7 / source 193963a.
// These are source strings for docs/downloads, not SDK imports in the browser.
const configurations = [
  {
    id: "e2b",
    label: "E2B",
    install: "npm install anchor-ai-sdk@0.1.7 'e2b@^2.56'",
    imports: 'import { e2b } from "anchor-ai-sdk/sandbox/e2b";',
    factory: `e2b({
  apiKey: requiredEnv("E2B_API_KEY"),
  template: requiredEnv("E2B_TEMPLATE"),
  timeoutMs: 60 * 60_000,
})`,
    setting: "E2B template name or ID",
    detail:
      "Build the template first, then set E2B_TEMPLATE to its name or ID. E2B does not accept an arbitrary Docker image at sandbox creation. timeoutMs is the sandbox lifetime, not a per-command timeout.",
    environment: ["OPENROUTER_KEY", "REPO_URL", "E2B_API_KEY", "E2B_TEMPLATE"],
  },
  {
    id: "heyo",
    label: "Heyo",
    install: "npm install anchor-ai-sdk@0.1.7 @heyocomputer/hws",
    imports: 'import { heyo } from "anchor-ai-sdk/sandbox/heyo";',
    factory: `heyo({
  token: requiredEnv("HEYO_TOKEN"),
  server: requiredEnv("HEYO_SERVER"),
  namespace: requiredEnv("HEYO_NAMESPACE"),
  image: requiredEnv("HEYO_IMAGE"),
  imageKind: "artifact",
  imageStore: requiredEnv("HEYO_IMAGE_STORE"),
  sizeClass: "small",
  diskSizeGb: 10,
})`,
    setting: "Prebuilt Heyo image artifact",
    detail:
      "Set HEYO_IMAGE and HEYO_IMAGE_STORE to an artifact and store you can access. Heyo configures its image on the provider; it rejects per-sandbox image and workspacePath. Host-built dockerfile/git image kinds are also available, with different boot requirements.",
    environment: [
      "OPENROUTER_KEY",
      "REPO_URL",
      "HEYO_TOKEN",
      "HEYO_SERVER",
      "HEYO_NAMESPACE",
      "HEYO_IMAGE",
      "HEYO_IMAGE_STORE",
    ],
  },
  {
    id: "docker",
    label: "Docker",
    install: "npm install anchor-ai-sdk@0.1.7",
    imports: 'import { docker } from "anchor-ai-sdk/sandbox/docker";',
    factory: `docker({
  image: process.env.ANCHOR_DOCKER_IMAGE ?? "anchor-node:local",
})`,
    setting: "Docker container image",
    detail:
      "Start a Docker daemon and build the example image below, or supply an accessible image with your toolchain. An image is required. spec.image overrides the provider default; dockerBin can point at a Docker CLI outside PATH.",
    environment: ["OPENROUTER_KEY", "REPO_URL"],
  },
  {
    id: "local",
    label: "Local",
    install: "npm install anchor-ai-sdk@0.1.7",
    imports: 'import { local } from "anchor-ai-sdk/sandbox/local";',
    factory: `local({
  rootDir: ".anchor/local-sandboxes",
})`,
    setting: "A working directory on this host",
    detail:
      "Development and trusted CI only. Commands run with your user's permissions, not in an isolated sandbox. No image or template is used. localPath can copy a host repository instead of cloning it.",
    environment: ["OPENROUTER_KEY", "REPO_URL"],
  },
];

export const sandboxExamples = ["heyo", "e2b", "docker", "local"].map((id) =>
  configurations.find((example) => example.id === id),
);

export const dockerfile = `FROM node:22-bookworm
RUN apt-get update \\
 && apt-get install -y --no-install-recommends bash git ca-certificates coreutils \\
 && rm -rf /var/lib/apt/lists/*`;

export const templateBuilder = `import { Template, defaultBuildLogger } from "e2b";

// E2B_API_KEY must be set. This performs a remote build and may incur cost.
const template = Template()
  .fromUbuntuImage("24.04")
  .runCmd([
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y --no-install-recommends bash git ca-certificates coreutils nodejs npm",
    "rm -rf /var/lib/apt/lists/*",
  ]);

await Template.build(template, "anchor-node", {
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: defaultBuildLogger(),
});`;

export const sharedSandboxRun = `// provider: from the selected configuration above.
// llm and compaction: from the model setup in the quickstart.
// Import codingAgent and runAgent from "anchor-ai-sdk".
const sandbox = provider.create({
  repoUrl: requiredEnv("REPO_URL"),
  ref: process.env.REPO_REF ?? "main",
});

try {
  await sandbox.start();
  const result = await runAgent(
    { task: "Run the tests and report what happened" },
    { llm, compaction, agent: codingAgent, sandbox },
  );
  console.log(result.summary, result.reason, result.evidence);
} finally {
  await sandbox.destroy();
}`;

// One complete file per provider, including imports, env validation and cleanup.
// Imports are safe to smoke-test without starting any paid remote sandboxes.
export function completeSandboxExample(example) {
  return `import { pathToFileURL } from "node:url";
import { codingAgent, llmFromCatalog, runAgent } from "anchor-ai-sdk";
${example.imports}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error("Set " + name + " before running this example.");
  return value;
}

export function createProvider() {
  return ${example.factory};
}

export async function main() {
  const provider = createProvider();
  const { llm, compaction } = await llmFromCatalog({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: requiredEnv("OPENROUTER_KEY"),
    model: process.env.MODEL ?? "z-ai/glm-5.3",
  });

${sharedSandboxRun
  .split("\n")
  .slice(3)
  .map((line) => "  " + line)
  .join("\n")}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
`;
}
