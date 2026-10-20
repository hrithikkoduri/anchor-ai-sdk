import React, { useState } from "react";
import * as Tabs from "@animate-ui/react/primitives/radix-ui/tabs";
import * as Accordion from "@animate-ui/react/primitives/radix-ui/accordion";
import { Download, Plus } from "lucide-react";
import { CodeBlock, CopyButton, repo } from "./ui.jsx";
import { ProviderBrand } from "./provider-brand.jsx";
import {
  sandboxExamples,
  completeSandboxExample,
  sharedSandboxRun,
  dockerfile,
  templateBuilder,
} from "./sandbox-examples.js";

export function SandboxSetup() {
  const [provider, setProvider] = useState("heyo");
  const selected = sandboxExamples.find((example) => example.id === provider);
  const complete = completeSandboxExample(selected);
  return (
    <>
      <p>
        Choose a provider and configure its template or image. The result is the
        same <code>Sandbox</code> interface, passed to the same{" "}
        <code>runAgent</code> call. Your toolchain, credentials, and provider
        account are still yours to supply.
      </p>
      <p className="doc-small">
        This is another dependency, not another loop: the host starts a machine,
        passes it as <code>options.sandbox</code>, and machine tools use
        <code>ctx.sandbox</code>. The examples below reuse <code>codingAgent</code>
        to isolate provider setup. The <a href="#assembled">final recipe</a>
        replaces that bundle with an agent assembled from your own phases,
        strategy, and tools.
      </p>
      <Tabs.Root
        value={provider}
        onValueChange={setProvider}
        className="custom-agent-tabs sandbox-config"
      >
        <Tabs.List aria-label="Sandbox provider configuration">
          {sandboxExamples.map((example) => (
            <Tabs.Trigger key={example.id} value={example.id}>
              <ProviderBrand id={example.id} />
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {sandboxExamples.map((example) => (
          <Tabs.Content value={example.id} key={example.id}>
            <p>
              <strong>{example.setting}.</strong> {example.detail}
            </p>
            <CodeBlock
              code={example.install}
              filename={`install-${example.id}`}
              language="SHELL"
            />
            <CodeBlock
              code={`${example.imports}\n\n// Configuration fragment; requiredEnv is included in the complete file.\nconst provider = ${example.factory};`}
              filename={`${example.id}-provider.mjs`}
              language="JAVASCRIPT"
            />
            <p className="provider-env">
              Set <code>{example.environment.join(", ")}</code>. Use a
              repository and ref you can access; the downloaded example defaults
              to <code>main</code>. Private repositories also need{" "}
              <code>spec.git.token</code>.
            </p>
          </Tabs.Content>
        ))}
      </Tabs.Root>
      <div className="agent-example-download">
        <span>Complete {selected.label} agent, not just a fragment.</span>
        <CopyButton
          text={complete}
          label={`Copy complete ${selected.label} sandbox example`}
        />
        <a
          href={`data:text/javascript;charset=utf-8,${encodeURIComponent(complete)}`}
          download={`${provider}-agent.mjs`}
        >
          Download .mjs <Download size={14} />
        </a>
      </div>
      <p className="doc-small">
        Save and run the downloaded file with{" "}
        <code>node {provider}-agent.mjs</code> after setting its environment
        variables. <code>.mjs</code> is standard JavaScript using ES modules,
        not an Anchor requirement. With <code>"type": "module"</code> in your
        package.json, <code>.js</code> works too. Cloud sandbox and model calls
        may incur cost.
      </p>
      <p className="doc-small">
        Provider peers can require a newer host runtime than Anchor's Node 20+
        baseline. For example, E2B 2.58.0 (allowed by the install range above)
        requires Node 22.19+. Check the resolved peer's engines and pin its
        version in your lockfile; the sandbox's image runtime is separate.
      </p>
      <Accordion.Root type="single" collapsible className="faq doc-accordion">
        <Accordion.Item value="run">
          <Accordion.Header>
            <Accordion.Trigger>
              The shared agent wiring
              <Plus size={16} />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>
            <CodeBlock
              code={sharedSandboxRun}
              filename="sandbox-run.mjs"
              language="JAVASCRIPT"
            />
            <p>
              The SDK runs tools through the provided sandbox. It does not
              install your repository’s dependencies or select a suitable
              language toolchain for you.
            </p>
          </Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="toolchain">
          <Accordion.Header>
            <Accordion.Trigger>
              Prepare an E2B template or Docker image
              <Plus size={16} />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>
            <p>
              <strong>E2B:</strong> build once, then use the resulting template
              name or ID. This example supplies basic Node tooling; adapt and
              pin its versions for your workload.
            </p>
            <CodeBlock
              code={templateBuilder}
              filename="build-template.mjs"
              language="JAVASCRIPT"
            />
            <CodeBlock
              code={`# E2B_API_KEY must already be exported\nnode build-template.mjs\nexport E2B_TEMPLATE="anchor-node"`}
              filename="template-commands"
              language="SHELL"
            />
            <p>
              <strong>Docker:</strong> save this as{" "}
              <code>Dockerfile.anchor</code> and build the image the Docker
              example references.
            </p>
            <CodeBlock
              code={dockerfile}
              filename="Dockerfile.anchor"
              language="DOCKERFILE"
            />
            <CodeBlock
              code="docker build -t anchor-node:local -f Dockerfile.anchor ."
              filename="image-build"
              language="SHELL"
            />
            <p>
              Templates/images need <code>bash</code>, <code>git</code>, and
              coreutils including <code>timeout</code>, plus the task’s language
              tools. Preparing an image is separate from starting a sandbox.
              Image pulls and builds add boot time.
            </p>
          </Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="images">
          <Accordion.Header>
            <Accordion.Trigger>
              Per-run images and existing workspaces
              <Plus size={16} />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>
            <CodeBlock
              code={`// E2B: spec.image means a TEMPLATE name or ID, not a Docker image.\nconst sandbox = provider.create({\n  image: "my-prepared-template",\n  workspacePath: "/testbed",\n});\n\n// Docker: spec.image means a CONTAINER image.\n// provider.create({ image: "my-registry/prepared-repo:tag", workspacePath: "/testbed" });`}
              filename="preloaded-workspace.mjs"
              language="JAVASCRIPT"
            />
            <p>
              <code>workspacePath</code> skips cloning and must point at an
              existing Git workspace in that template/image. Heyo uses its
              configured provider image and rejects this per-run override. Local
              uses <code>localPath</code> for copying host directories instead.
            </p>
          </Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="heyo-images">
          <Accordion.Header>
            <Accordion.Trigger>
              Heyo image kinds and private Git access
              <Plus size={16} />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>
            <p>
              <code>imageKind: "artifact"</code> pulls a prebuilt image from{" "}
              <code>imageStore</code>. The <code>dockerfile</code> and{" "}
              <code>git</code> kinds build on the host; git builds also use{" "}
              <code>imageRepo</code>, <code>imageRef</code>, and{" "}
              <code>imageDockerfile</code>. They are not arbitrary Docker images
              passed to <code>spec.image</code>.
            </p>
            <CodeBlock
              code={`// For a private HTTPS repository, add to provider.create({...}):\ngit: {\n  token: async () => obtainFreshGitToken(),\n  username: "x-access-token",\n},\ngitIdentity: { name: "Your bot", email: "bot@example.com" },`}
              filename="private-repo-options.ts"
            />
            <p>
              <code>obtainFreshGitToken</code> is your own credential service,
              not an SDK export. For private Heyo git-kind image builds,{" "}
              <code>imageAuth</code> and optional <code>prepare</code>/
              <code>buildSecretRefresh</code> configure the host build’s
              credentials separately from workspace clone/push credentials.
            </p>
            <a
              className="doc-inline-link"
              href={`${repo}/blob/main/src/sandbox/README.md`}
            >
              Provider and image reference
            </a>
          </Accordion.Content>
        </Accordion.Item>
      </Accordion.Root>
      <a className="doc-inline-link" href="#engine">
        Next: connect the loop and bound its work
      </a>
    </>
  );
}
