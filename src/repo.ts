/**
 * Peer-repository workspaces. The sandbox workspace is a container; each repo
 * is a peer checkout with its own .git. Tools target one repo per call, and the
 * dispatcher may run mutations in different repos concurrently.
 */
import path from "node:path";

export interface RepoRef {
  /** Stable consumer name, e.g. "acme/api". */
  name: string;
  /** Relative to the sandbox workspace, e.g. "api". Must stay inside it. */
  path: string;
  /** Optional base branch for the repo. */
  baseRef?: string;
}

export function validateRepos(repos: readonly RepoRef[], workspace: string): void {
  const root = path.resolve(workspace);
  const names = new Set<string>();
  for (const repo of repos) {
    if (!repo.name.trim()) throw new Error("repo name must not be empty");
    if (names.has(repo.name)) {
      throw new Error(`duplicate repo name "${repo.name}"`);
    }
    names.add(repo.name);
    if (!repo.path.trim()) throw new Error(`repo "${repo.name}" needs a path`);
    if (path.isAbsolute(repo.path)) {
      throw new Error(`repo "${repo.name}" path must be relative to the workspace`);
    }
    if (repo.path.split(/[\\/]/).includes("..")) {
      throw new Error(`repo "${repo.name}" path must not contain ".."`);
    }
    const cwd = path.resolve(root, repo.path);
    const relative = path.relative(root, cwd);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`repo "${repo.name}" path escapes the workspace`);
    }
  }
}

export function repoByName(
  repos: readonly RepoRef[] | undefined,
  name: string,
): RepoRef | undefined {
  const exact = repos?.find((repo) => repo.name === name);
  if (exact) return exact;
  // "web" for "acme/web": the short name, when only one
  // attached repository has it. Two repositories sharing it stay ambiguous.
  const wanted = name.trim().toLowerCase();
  const short = repos?.filter((repo) => repo.name.split("/").pop()?.toLowerCase() === wanted) ?? [];
  return short.length === 1 ? short[0] : undefined;
}

export function repoCwd(workspace: string, repo: RepoRef): string {
  return path.resolve(workspace, repo.path);
}

/**
 * Longest-prefix repository match for a file path. Relative paths are resolved
 * from the workspace; a file outside every repo returns undefined.
 */
export function repoForPath(
  repos: readonly RepoRef[] | undefined,
  file: string,
  workspace: string,
): RepoRef | undefined {
  if (!repos?.length) return undefined;
  const absolute = path.isAbsolute(file)
    ? path.normalize(file)
    : path.resolve(workspace, file);
  let best: RepoRef | undefined;
  let bestLength = -1;
  for (const repo of repos) {
    const cwd = repoCwd(workspace, repo);
    const relative = path.relative(cwd, absolute);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    if (cwd.length > bestLength) {
      best = repo;
      bestLength = cwd.length;
    }
  }
  return best;
}
