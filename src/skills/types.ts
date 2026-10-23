/**
 * Skills are consumer-owned instruction bundles. Anchor supplies the compact
 * index and the on-demand loader; it does not own storage, trust, or content.
 */
export interface SkillMeta {
  /** Unique within the consumer's namespace, e.g. "builtin:code-review". */
  name: string;
  /** One line; this is all the model sees before loading. */
  description: string;
  /** Consumer-defined scope, e.g. "builtin" | "account" | "repo". */
  scope?: string;
  /** Consumer-defined version, commit, or hash. */
  version?: string;
}

export interface SkillContent {
  meta: SkillMeta;
  /** The SKILL.md body, with frontmatter stripped by the consumer. */
  body: string;
  /** Absolute or workspace-relative directory the skill lives in. */
  basePath?: string;
  /** Files beside the body; read with read_file/bash, never executed here. */
  resources?: string[];
}

export interface SkillProvider {
  list(): Promise<SkillMeta[]> | SkillMeta[];
  load(name: string): Promise<SkillContent | undefined> | SkillContent | undefined;
}
