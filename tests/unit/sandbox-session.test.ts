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
  SandboxGoneError,
  openSandboxSession,
} from "../../src/sandbox/index.js";
import type { Sandbox, SandboxProvider } from "../../src/sandbox/index.js";
import { LocalSandbox, local } from "../../src/sandbox/local/index.js";

/**
 * A provider whose adopt path runs a scripted sequence: "transient" throws a
 * git-config lock error (retryable), "gone" throws SandboxGoneError (dead).
 * Records how many times each path ran, so a test can prove a transient failure
 * never became a fresh `create`.
 */
function scriptedProvider(script: Array<"ok" | "transient" | "gone">) {
  const calls = { create: 0, adopt: 0 };
  let step = 0;
  const sandbox = (id: string, kind: "create" | "adopt"): Sandbox =>
    ({
      id,
      backend: "fake",
      async start() {
        if (kind === "create") {
          calls.create += 1;
          return;
        }
        calls.adopt += 1;
        const action = script[Math.min(step, script.length - 1)] ?? "ok";
        step += 1;
        if (action === "transient")
          throw new Error(
            "git config user.name failed (128): error: could not lock config file .git/config: File exists",
          );
        if (action === "gone") throw new SandboxGoneError("no such sandbox");
      },
      async destroy() {},
    }) as unknown as Sandbox;
  const provider = {
    name: "fake",
    capabilities: {
      fork: false,
      retain: true,
      remoteCheckpoint: false,
      egressControl: false,
      localPath: false,
      previewPort: false,
    },
    create: () => sandbox("created-1", "create"),
    adopt: () => sandbox("retained-1", "adopt"),
    release: async () => undefined,
    probe: async () => ({ ok: true, name: "fake" }),
    isGone: (error: unknown) => error instanceof SandboxGoneError,
  } as unknown as SandboxProvider;
  return { provider, calls };
}

const retained = (id: string) => ({ retained: { id, backend: "fake" } });

describe("openSandboxSession — transient is not gone", () => {
  it("retries a transient adopt failure and keeps the recorded pointer", async () => {
    const { provider, calls } = scriptedProvider(["transient", "ok"]);
    const store = new MemorySandboxStore();
    store.set("thread", retained("retained-1"));
    const sandbox = await openSandboxSession({
      provider,
      store,
      key: "thread",
      sources: [{ spec: {} }],
      adoptRetries: 4,
      adoptBackoffMs: 1,
    });
    expect(sandbox.id).toBe("retained-1");
    expect(calls.adopt).toBe(2); // locked once, retried
    expect(calls.create).toBe(0); // never a fresh sandbox over the record
    expect(store.get("thread")?.retained?.id).toBe("retained-1");
  });

  it("fails loudly after the retries — never a silent fresh create", async () => {
    const { provider, calls } = scriptedProvider(["transient"]);
    const store = new MemorySandboxStore();
    store.set("thread", retained("retained-1"));
    await expect(
      openSandboxSession({
        provider,
        store,
        key: "thread",
        sources: [{ spec: {} }],
        adoptRetries: 1,
        adoptBackoffMs: 1,
      }),
    ).rejects.toThrow(/on record but unavailable/);
    expect(calls.create).toBe(0);
    expect(store.get("thread")?.retained?.id).toBe("retained-1"); // pointer intact
  });

  it("clears the pointer and builds fresh only when the provider says gone", async () => {
    const { provider, calls } = scriptedProvider(["gone"]);
    const store = new MemorySandboxStore();
    store.set("thread", retained("retained-1"));
    const sandbox = await openSandboxSession({
      provider,
      store,
      key: "thread",
      sources: [{ spec: {} }],
      adoptRetries: 4,
      adoptBackoffMs: 1,
    });
    expect(sandbox.id).toBe("created-1");
    expect(calls.create).toBe(1);
    expect(store.get("thread")?.retained?.id).toBe("created-1");
  });
});

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
