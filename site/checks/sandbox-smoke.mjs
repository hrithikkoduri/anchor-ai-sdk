import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, join } from "node:path";
import { test } from "node:test";
import {
  sandboxExamples,
  completeSandboxExample,
} from "../src/sandbox-examples.js";

const sdkEntry =
  process.env.ANCHOR_SDK_ENTRY ??
  fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const sdkDist = dirname(sdkEntry);
const extension = extname(sdkEntry);
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Network access is forbidden in this docs smoke check");
};
const values = {
  OPENROUTER_KEY: "docs-not-a-real-key",
  REPO_URL: "https://example.invalid/repo.git",
  REPO_REF: "main",
  E2B_API_KEY: "docs-not-a-real-key",
  E2B_TEMPLATE: "docs-template",
  HEYO_TOKEN: "applb_docs_offline_fixture",
  HEYO_SERVER: "https://example.invalid",
  HEYO_NAMESPACE: "docs",
  HEYO_IMAGE: "docs/toolchain:v1",
  HEYO_IMAGE_STORE: "https://example.invalid/images",
};
for (const [name, value] of Object.entries(values)) process.env[name] = value;

for (const example of sandboxExamples) {
  test(
    `${example.label} example imports and constructs without booting`,
    { timeout: 20_000 },
    async () => {
      let source = completeSandboxExample(example);
      source = source.replace(
        '"anchor-ai-sdk"',
        JSON.stringify(pathToFileURL(sdkEntry).href),
      );
      source = source.replace(
        `"anchor-ai-sdk/sandbox/${example.id}"`,
        JSON.stringify(
          pathToFileURL(
            join(sdkDist, "sandbox", example.id, `index${extension}`),
          ).href,
        ),
      );
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
      );
      assert.equal(typeof module.main, "function");
      const provider = module.createProvider();
      assert.equal(provider.name, example.id);
      const sandbox = provider.create({
        repoUrl: values.REPO_URL,
        ref: "main",
      });
      assert.equal(sandbox.backend, example.id);
      for (const method of [
        "start",
        "exec",
        "checkpoint",
        "hasChangesFrom",
        "destroy",
      ])
        assert.equal(typeof sandbox[method], "function");
      assert.equal(provider.capabilities.retain, true);
      assert.equal(
        provider.capabilities.fork,
        ["e2b", "local"].includes(example.id),
      );
      assert.equal(provider.capabilities.localPath, example.id === "local");
        assert.equal(provider.capabilities.egressControl, example.id === "docker");
      // No start(), probe(), Template.build(), or other paid/vendor operation.
    },
  );
}

process.on("exit", () => {
  globalThis.fetch = originalFetch;
});
