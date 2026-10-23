# Composition helpers

These are small conveniences over the existing engine and tool contracts. They
do not create a second runtime.

## `createAnchor`

`createAnchor` captures the model, agent, sandbox, tools, and optional thread
that an application reuses across runs:

```ts
import { codingAgent, createAnchor, llmFromCatalog } from "anchor-ai-sdk";

const { llm, compaction } = await llmFromCatalog({ ... });

const anchor = createAnchor({
  llm,
  agent: codingAgent,
  sandbox,
  thread: { store, id: threadId },
  defaults: { compaction },
});

const result = await anchor.run("Fix the failing test");
const status = await anchor.doctor();
```

Per-run options override the captured defaults:

```ts
await anchor.run("Review the diff", { verifier: true });
```

`doctor()` is a cheap check. With no sandbox it only reports the model/agent
configuration. With a started sandbox it also checks `exec("true")`; it does not
start or mutate the sandbox.

## Prompt components

The coding prompt sections are exported so a product can amend one rule without
copying the whole prompt:

```ts
import {
  buildCodingPrompt,
  codingPromptComponents,
} from "anchor-ai-sdk";

const prompt = buildCodingPrompt({
  character: `${codingPromptComponents.character} Prefer small, reversible changes.`,
});
```

Available components: `character`, `tone`, `judgment`, `operatingRules`, and
`verification`. Passing a component replaces that section; passing a new
strategy still replaces the whole prompt.

## `view_image`

`view_image` is for text-only agents. The consumer supplies the actual vision
step; Anchor reads the sandbox image, validates its MIME type/size, and passes a
data URL plus optional prompt:

```ts
import { createViewImageTool } from "anchor-ai-sdk";

const viewImage = createViewImageTool({
  async describe({ dataUrl, mime, prompt }) {
    // Call a vision model, OCR service, or your own analyzer.
    return `Description for ${mime}: ...`;
  },
});

const agent = { ...codingAgent, tools: [...codingAgent.tools, viewImage] };
```

The callback receives `{ path, mime, sizeBytes, base64, dataUrl, prompt? }`.
Files are capped at 8 MiB by default; pass `maxBytes` to change that. Images are
read from the sandbox and are never uploaded or persisted by the SDK.

## Verification

- `tests/unit/anchor.test.ts`
- `tests/unit/coding-prompts.test.ts`
- `tests/unit/view-image.test.ts`
