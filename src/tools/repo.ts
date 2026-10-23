/** Shared repository targeting for workspace-aware tools. */
import { repoByName, repoCwd, repoForPath, type RepoRef } from "../repo.js";
import type { ToolContext } from "./types.js";

export interface RepoSelection {
  repo?: RepoRef;
  cwd: string;
  error?: string;
}

/**
 * Resolve a tool's `repository` argument.
 *
 * - no configured repos: the workspace root is the only repo
 * - one configured repo, no argument: that repo
 * - multiple configured repos, no argument: the workspace root (explicit
 *   spanning-command escape hatch)
 * - named repo: that repo, or an attributable failed result
 */
export function selectRepo(
  ctx: ToolContext,
  name: string | undefined,
): RepoSelection {
  const sandbox = ctx.sandbox;
  const workspace = sandbox?.workspace ?? "";
  const repos = ctx.repos;
  if (name) {
    const repo = repoByName(repos, name);
    if (!repo) {
      return {
        cwd: workspace,
        error: `unknown repository "${name}" — available: ${(repos ?? []).map((item) => item.name).join(", ") || "(none)"}`,
      };
    }
    return { repo, cwd: repoCwd(workspace, repo) };
  }
  if (repos?.length === 1) {
    return { repo: repos[0], cwd: repoCwd(workspace, repos[0]!) };
  }
  return { cwd: workspace };
}

export function resourceForRepo(
  ctx: ToolContext,
  name: string | undefined,
): string | undefined {
  if (name) return name;
  return ctx.repos?.length === 1 ? ctx.repos[0]!.name : undefined;
}

/** Repository owning a file path, for edit_file's mutation resource key. */
export function resourceForPath(
  ctx: ToolContext,
  file: string,
): string | undefined {
  return repoForPath(
    ctx.repos,
    file,
    ctx.sandbox?.workspace ?? "",
  )?.name;
}
