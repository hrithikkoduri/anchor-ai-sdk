/**
 * Store-backed sessions — the package owns the continuity policy (adopt,
 * clear stale pointers, try sources in order); the consumer owns persistence.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MemorySandboxStore,
  openSandboxSession,
} from "../../src/sandbox/index.js";
import { LocalSandbox, local } from "../../src/sandbox/local.js";

describe("openSandboxSession", () => {
  it("remembers the handle, adopts it next time, and clears it when gone", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anchor-session-"));
    const store = new MemorySandboxStore();
    const provider = local({ rootDir });
    const sources = [{ spec: {} }];
    let first: LocalSandbox | undefined;
    try {
      first = (await openSandboxSession({
        provider,
        store,
        key: "thread-1",
        sources,
      })) as LocalSandbox;
      expect(store.get("thread-1")?.retained).toEqual({
        id: first.id,
        backend: "local",
      });

      // Second open: the retained workspace is adopted, same id.
      const again = await openSandboxSession({
        provider,
        store,
        key: "thread-1",
        sources,
      });
      expect(again.id).toBe(first.id);

      // A handle that is gone: the store is cleared, a fresh sandbox opens.
      store.set("thread-1", {
        retained: { id: "does-not-exist", backend: "local" },
      });
      const fresh = await openSandboxSession({
        provider,
        store,
        key: "thread-1",
        sources,
      });
      expect(fresh.id).not.toBe("does-not-exist");
      expect(store.get("thread-1")?.retained?.id).toBe(fresh.id);

      await fresh.destroy();
    } finally {
      if (first) await first.destroy().catch(() => undefined);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("tries sources in order and reports a dead ref before falling back", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anchor-session-"));
    const store = new MemorySandboxStore();
    const provider = local({ rootDir });
    const unusable: string[] = [];
    try {
      const sandbox = await openSandboxSession({
        provider,
        store,
        key: "thread-2",
        sources: [
          {
            spec: {
              repoUrl: "file:///nonexistent/origin.git",
              ref: "checkpoint-x",
            },
          },
          { spec: {} },
        ],
        onRefUnusable: (ref) => {
          unusable.push(ref);
        },
      });
      expect(unusable).toEqual(["checkpoint-x"]);
      expect(store.get("thread-2")?.retained?.id).toBe(sandbox.id);
      await sandbox.destroy();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
