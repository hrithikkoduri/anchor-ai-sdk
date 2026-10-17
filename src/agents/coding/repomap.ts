/**
 * Repo map — a compact orientation document written before the run starts.
 *
 * Coding-strategy utility (not framework API): two cheap probes instead of an
 * index — the file list (tracked + untracked, so the local backend's copies
 * show up too) and the heads of the ecosystem's manifest files. Truncated
 * like any tool output so it can't flood the context.
 */
import type { Sandbox } from "../../sandbox/types.js";
import { truncate } from "../../tools/truncate.js";

export async function buildRepoMap(sandbox: Sandbox, opts: { maxFiles?: number } = {}): Promise<string> {
  const maxFiles = opts.maxFiles ?? 120;
  const parts: string[] = [];

  const listCmd = `git ls-files --cached --others --exclude-standard | head -n ${maxFiles}`;
  const files = await sandbox.exec(listCmd, { timeoutSecs: 60 });
  if (files.exitCode === 0 && files.stdout.trim() !== "") {
    const count = await sandbox.exec("git ls-files --cached --others --exclude-standard | wc -l", {
      timeoutSecs: 60,
    });
    const total = Number.parseInt(count.stdout.trim(), 10);
    const suffix = Number.isFinite(total) && total > maxFiles ? ` (of ${total})` : "";
    parts.push(`# Files${suffix}\n${files.stdout.trimEnd()}`);
  }

  const manifests = await sandbox.exec(
    `for f in package.json pyproject.toml Cargo.toml go.mod Makefile; do ` +
      `if [ -f "$f" ]; then echo "--- $f"; head -n 30 "$f"; fi; done`,
    { timeoutSecs: 60 },
  );
  if (manifests.exitCode === 0 && manifests.stdout.trim() !== "") {
    parts.push(`# Manifests\n${manifests.stdout.trimEnd()}`);
  }

  return truncate(parts.join("\n\n"), { maxLines: 160, maxChars: 8000 });
}
