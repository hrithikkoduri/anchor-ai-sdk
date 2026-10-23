import type { SkillMeta } from "./types.js";

export * from "./types.js";

export interface RenderSkillIndexOptions {
  /** Maximum entries before the "more" line. Default 30. */
  maxSkills?: number;
  /** Maximum description characters. Default 200. */
  maxDescription?: number;
}

function truncateDescription(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Render the compact skill index for a consumer-owned prompt.
 *
 * The order is deterministic (name) so the same skill set produces a stable
 * cacheable prefix. Bodies are never included; only names/descriptions/scopes.
 */
export function renderSkillIndex(
  metas: readonly SkillMeta[],
  opts: RenderSkillIndexOptions = {},
): string {
  if (metas.length === 0) return "";
  const maxSkills = Math.max(0, Math.floor(opts.maxSkills ?? 30));
  const maxDescription = Math.max(1, Math.floor(opts.maxDescription ?? 200));
  const sorted = [...metas].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const shown = sorted.slice(0, maxSkills);
  const lines = shown.map((meta) => {
    const description = truncateDescription(meta.description, maxDescription);
    const scope = meta.scope ? ` (${meta.scope})` : "";
    return `- ${meta.name} — ${description}${scope}`;
  });
  const remaining = sorted.length - shown.length;
  if (remaining > 0) {
    lines.push(`… ${remaining} more`);
  }
  return lines.join("\n");
}
