/**
 * The batch's per-op cache, kept IN the sandbox so it survives turns and dies
 * with the sandbox (one per thread when the consumer keeps one per thread).
 *
 * Only reads and searches are cached. Each entry is keyed by its inputs and a
 * stamp the sandbox computes at lookup time:
 *
 *   read    the file's content hash (sha256) — a changed byte is a miss
 *   search  a hash of the scope's file listing (path, size, mtime, ctime),
 *           `.git` excluded — an added, removed or touched file is a miss
 *
 * A miss is stored only if the stamp is still the same after the op ran, so a
 * file that changed while it was being read is never filed under the old
 * stamp. Commands, edits and writes are never cached here. Entries are files
 * under one directory, evicted oldest-used first past `maxBytes`.
 *
 * Lookups for a whole phase share one exec, and so do its stores: on a
 * microVM the round trip, not the work, is the cost.
 */
import { createHash } from "node:crypto";
import { shq, type Sandbox } from "../../sandbox/types.js";

export interface BatchCacheOptions {
  /** Directory inside the sandbox. Default: `<sandbox.scratch>/batch-cache`. */
  dir?: string;
  /** Evict oldest-used entries past this size. Default 200 MB. */
  maxBytes?: number;
}

export const BATCH_CACHE_MAX_BYTES = 200 * 1024 * 1024;
/** Larger results are not worth a slot (and would strain one exec's argv). */
const STORE_MAX_CHARS = 40_000;
const MARK = "@@anchor-batch-cache ";
/** Below Linux's 128 KB limit on one argv string, with room for the helpers. */
export const SCRIPT_MAX_CHARS = 90_000;

export interface CacheQuery {
  /** Caller's handle for this entry. */
  id: string;
  /** Everything but the stamp that decides the result. */
  parts: Record<string, unknown>;
  /** Shell that prints this entry's stamp (a hash) on stdout, or nothing. */
  stamp: string;
}

export type CacheLookup =
  | { state: "hit"; content: string }
  | { state: "miss"; key: string; stamp: string; script: string }
  | { state: "none" };

const HELPERS = [
  `__h() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -c1-64; }`,
  // GNU find prints the listing itself; BSD find hands it to stat(1).
  `__l() { if find . -maxdepth 0 -printf '' >/dev/null 2>&1; then find "$1" -name .git -prune -o -type f -printf '%p %s %T@ %C@\\n' 2>/dev/null; else find "$1" -name .git -prune -o -type f -exec stat -f '%N %z %Fm %Fc' {} + 2>/dev/null; fi | LC_ALL=C sort; }`,
].join("\n");

/** Stamp: the content hash of one file (nothing when it is not a file). */
export const fileStamp = (path: string) => `[ -f ${shq(path)} ] && __h < ${shq(path)}`;

/** Stamp: a hash of the scope's file listing. */
export const treeStamp = (scope: string) => `[ -e ${shq(scope)} ] && __l ${shq(scope)} | __h`;

const prefixOf = (parts: Record<string, unknown>) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

export function cacheDir(sandbox: Sandbox, options: BatchCacheOptions): string {
  return options.dir ?? `${sandbox.scratch}/batch-cache`;
}

/** One exec: every query's stamp, and the stored result when its key exists. */
export async function lookup(sandbox: Sandbox, dir: string, queries: readonly CacheQuery[]): Promise<Map<string, CacheLookup>> {
  const out = new Map<string, CacheLookup>();
  if (queries.length === 0) return out;
  const body = queries.map((query, i) => {
    const prefix = prefixOf(query.parts);
    return [
      `__s=$( ${query.stamp} ) && [ -n "$__s" ] && {`,
      `  __k=$(printf '%s|%s' ${shq(prefix)} "$__s" | __h)`,
      `  if [ -f "$__d/$__k" ]; then touch "$__d/$__k"; printf '\\n${MARK}${i} hit %s %s\\n' "$__k" "$__s"; base64 < "$__d/$__k" | tr -d '\\n';`,
      `  else printf '\\n${MARK}${i} miss %s %s\\n' "$__k" "$__s"; fi`,
      `} || printf '\\n${MARK}${i} none\\n'`,
    ].join("\n");
  });
  const script = [HELPERS, `__d=${shq(dir)}`, `mkdir -p "$__d" 2>/dev/null`, ...body].join("\n");
  const result = await sandbox.exec(script, { timeoutSecs: 60, concurrent: true }).catch(() => undefined);
  for (const query of queries) out.set(query.id, { state: "none" });
  if (!result) return out;
  const chunks = result.stdout.split(`\n${MARK}`).slice(1);
  for (const chunk of chunks) {
    const newline = chunk.indexOf("\n");
    const head = (newline === -1 ? chunk : chunk.slice(0, newline)).trim().split(" ");
    const rest = newline === -1 ? "" : chunk.slice(newline + 1).trim();
    const query = queries[Number(head[0])];
    if (!query) continue;
    const [, state, key, stamp] = head;
    if (state === "hit" && key) {
      try {
        out.set(query.id, { state: "hit", content: Buffer.from(rest, "base64").toString("utf8") });
      } catch {
        /* an unreadable entry is a miss without a slot */
      }
    } else if (state === "miss" && key && stamp && /^[0-9a-f]{64}$/.test(key)) {
      out.set(query.id, { state: "miss", key, stamp, script: query.stamp });
    }
  }
  return out;
}

/** Whether a result is worth a slot: complete, self-contained, and small. */
export function cacheable(ok: boolean, content: string): boolean {
  return ok && content.length <= STORE_MAX_CHARS && !content.includes("full output saved:");
}

/**
 * Store misses whose stamp still holds, then evict past the size bound. Best
 * effort: a store that fails costs a later miss, never a wrong answer.
 */
export async function store(
  sandbox: Sandbox,
  dir: string,
  maxBytes: number,
  items: ReadonlyArray<{ key: string; stamp: string; script: string; content: string }>,
): Promise<void> {
  if (items.length === 0) return;
  const writes = items.map((item) => {
    const b64 = Buffer.from(item.content, "utf8").toString("base64");
    return `if [ "$( ${item.script} )" = ${shq(item.stamp)} ]; then printf %s ${shq(b64)} | base64 -d > "$__d/${item.key}.tmp.$$" && mv -f "$__d/${item.key}.tmp.$$" "$__d/${item.key}"; fi`;
  });
  const maxKb = Math.max(1, Math.floor(maxBytes / 1024));
  const evict = `while [ "$(du -sk "$__d" 2>/dev/null | cut -f1)" -gt ${maxKb} ]; do __f=$(ls -tr "$__d" | head -n 1); [ -n "$__f" ] || break; rm -f "$__d/$__f"; done`;
  // One script is one argv string on the guest, which Linux caps at 128 KB.
  const groups: string[][] = [[]];
  let size = 0;
  for (const write of writes) {
    if (size + write.length > SCRIPT_MAX_CHARS && groups[groups.length - 1]!.length > 0) {
      groups.push([]);
      size = 0;
    }
    groups[groups.length - 1]!.push(write);
    size += write.length;
  }
  for (const [i, group] of groups.entries()) {
    const script = [HELPERS, `__d=${shq(dir)}`, `mkdir -p "$__d"`, ...group, ...(i === groups.length - 1 ? [evict] : [])].join("\n");
    await sandbox.exec(script, { timeoutSecs: 60, concurrent: true }).catch(() => undefined);
  }
}
