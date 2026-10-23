# Skills: progressive disclosure

A skill is a consumer-owned instruction bundle: a name, a one-line
description, a `SKILL.md` body, and optional resources/scripts. Putting every
body in the system prompt does not scale. Anchor supplies a compact index and an
on-demand `load_skill` tool; the consumer owns discovery, storage, precedence,
enablement, trust, and content.

## Provider contract

```ts
import type {
  SkillContent,
  SkillMeta,
  SkillProvider,
} from "anchor-ai-sdk";

const provider: SkillProvider = {
  async list() {
    return [
      {
        name: "builtin:code-review",
        description: "Review a diff for correctness and missing tests",
        scope: "builtin",
        version: "v1",
      },
    ];
  },
  async load(name) {
    if (name !== "builtin:code-review") return undefined;
    return {
      meta: { name, description: "Review a diff", scope: "builtin" },
      body: "Read the diff, then run the relevant tests.",
      basePath: "skills/code-review",
      resources: ["checklist.md"],
    };
  },
};
```

The consumer turns files, database rows, or image content into `SkillContent`.
Anchor does not parse YAML frontmatter or enforce a naming convention beyond a
non-empty name.

## Prompt index

```ts
import { renderSkillIndex } from "anchor-ai-sdk";

const index = renderSkillIndex(await provider.list(), {
  maxSkills: 30,
  maxDescription: 200,
});
```

The index is sorted by name, one line per skill, and returns `""` when there are
no skills. Inject it into the consumer-owned prompt.

## Loader

```ts
import { createSkillTools } from "anchor-ai-sdk";

const skillTools = createSkillTools({
  provider,
  maxBodyChars: 16_000,
});

const agent = {
  ...codingAgent,
  tools: [...codingAgent.tools, ...skillTools],
};
```

`load_skill({ name })` does an exact-name lookup and returns:

- the bounded `SKILL.md` body
- the skill scope/version when provided
- the base path and resource names for follow-up `read_file`/`bash`
- trace metadata: `{ name, scope?, version?, bytes, bodyChars, truncated }`

Unknown names return a failed result listing the available skills.

## Safety

- The body is untrusted text and enters context as a **tool result**, never as a
  system message.
- The loader does not execute scripts, fetch URLs, scan a filesystem, or grant
  capabilities.
- Scripts use the existing `bash` tool under the normal sandbox, secret, and
  task-contract rules.
- `load_skill` is `readOnly: true`, so it can run alongside other read-only
  calls.
- Skills cannot bypass the contract, judge, publication gates, or secret
  handling.

## Non-goals

Anchor does not own skill storage, discovery, precedence, enablement, trust,
upload/import UI, audit, or built-in content. There is no
`EngineOptions.skills`; the consumer composes the prompt and registers the tool.
