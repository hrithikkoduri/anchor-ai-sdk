/**
 * The sandbox layer's entry points: providers and their lifecycle.
 *
 * Production code opens sandboxes through a `SandboxProvider` and never
 * depends on concrete classes. The classes, factories, and their SDKs — and
 * any one provider's vocabulary — live on subpaths so this root entry stays
 * SDK-free (type-only imports are erased):
 *
 *   anchor-ai-sdk/sandbox/heyo    → heyo(), HeyoSandbox, probeHeyo,
 *                                  upsertHeyoSecret (imports @heyocomputer/hws)
 *   anchor-ai-sdk/sandbox/local   → local(), LocalSandbox (dev/CI — no isolation)
 *   anchor-ai-sdk/sandbox/docker  → docker(), DockerSandbox
 *   anchor-ai-sdk/sandbox/e2b     → e2b() — stub, coming soon
 *   anchor-ai-sdk/sandbox/daytona → daytona() — stub, coming soon
 *
 * Two ways to open one: `openSandbox` for explicit callbacks, and
 * `openSandboxSession` for store-backed continuity. README.md in this
 * directory is the guide for new providers: the contract, the shared
 * git/exec infra, and the conformance suite that accepts an adapter.
 */
import type { Sandbox, SandboxSpec } from "./types.js";
import type { SandboxHandle, SandboxProvider } from "./provider.js";

export * from "./types.js";
export * from "./provider.js";
export type { HeyoSandboxConfig } from "./heyo/index.js";
export type { LocalSandboxOptions } from "./local/index.js";

export interface OpenSandboxArgs {
  /** The provider to open with — explicit, always (decision #53). */
  provider: SandboxProvider;
  /** Base spec for a fresh sandbox when no retained one applies. */
  spec: SandboxSpec;
  /** The retained sandbox to try first (this thread's own — see SandboxSpec.retain). */
  adopt?: SandboxHandle;
  /** Retry spec when `spec.ref` turns out unusable (e.g. a deleted branch). */
  fallbackSpec?: SandboxSpec;
  /** The retained sandbox was gone — the owner clears its stale pointer here. */
  onRetainedGone?: (handle: SandboxHandle) => Promise<void> | void;
  /** `spec.ref` was unusable — the owner clears its stale ref here. */
  onRefUnusable?: (ref: string) => Promise<void> | void;
}

/**
 * Open the sandbox for a piece of work — the lifecycle a product runs:
 *   1. adopt the retained handle when one applies (SAME workspace, edits intact);
 *   2. on failure, report it (onRetainedGone) and build a fresh sandbox;
 *   3. when the fresh clone's `ref` is unusable, report it (onRefUnusable) and
 *      retry `fallbackSpec`.
 * The callbacks are bookkeeping for the owner (clearing DB pointers); they
 * must not throw. A handle owned by a different provider is skipped silently —
 * it is not gone, just not usable in this configuration.
 */
export async function openSandbox(args: OpenSandboxArgs): Promise<Sandbox> {
  const { provider } = args;
  // A handle owned by a different provider is skipped silently — it is not
  // gone, just not usable in this configuration.
  if (args.adopt && args.adopt.backend === provider.name) {
    const adopted = provider.adopt(args.adopt, args.spec);
    try {
      await adopted.start();
      return adopted;
    } catch {
      await args.onRetainedGone?.(args.adopt);
    }
  }
  const fresh = provider.create(args.spec);
  try {
    await fresh.start();
    return fresh;
  } catch (err) {
    if (!args.spec.ref || !args.fallbackSpec) throw err;
    await args.onRefUnusable?.(args.spec.ref);
    const fallback = provider.create(args.fallbackSpec);
    await fallback.start();
    return fallback;
  }
}

/**
 * Release a retained sandbox: destroy it by handle alone — no workspace spec,
 * no start(). A sandbox that is already gone is not an error. Pass the same
 * provider the sandbox was created with — a local backend's `rootDir`
 * matters here.
 */
export async function releaseSandbox(
  handle: SandboxHandle,
  provider: SandboxProvider,
): Promise<void> {
  await provider.release(handle);
}

/** What a session remembers between runs: the retained handle, if any. */
export interface SandboxSession {
  retained?: SandboxHandle;
}

/**
 * Where continuity lives between runs — memory, a table, a file. Keys are
 * opaque to the package (a thread id, a task id). The package never owns a
 * database: `openSandboxSession` calls this, the consumer implements it.
 */
export interface SandboxStore {
  get(key: string): SandboxSession | null | Promise<SandboxSession | null>;
  set(key: string, session: SandboxSession): void | Promise<void>;
  clear(key: string): void | Promise<void>;
}

/** In-memory store: tests, demos, and single-process consumers. */
export class MemorySandboxStore implements SandboxStore {
  private readonly sessions = new Map<string, SandboxSession>();

  get(key: string): SandboxSession | null {
    return this.sessions.get(key) ?? null;
  }

  set(key: string, session: SandboxSession): void {
    this.sessions.set(key, session);
  }

  clear(key: string): void {
    this.sessions.delete(key);
  }
}

/** One candidate for a fresh sandbox: the spec, newest-usable first. */
export interface SandboxSource {
  spec: SandboxSpec;
}

export interface OpenSandboxSessionArgs {
  provider: SandboxProvider;
  /** Continuity between runs (memory, Postgres, a file). */
  store: SandboxStore;
  /** Stable key for this work-stream — a thread id, a task id. Opaque. */
  key: string;
  /**
   * Ordered candidates for a fresh sandbox, newest-usable first; the LAST one
   * should be ref-less (a base clone). At least one is required.
   */
  sources: SandboxSource[];
  /**
   * A source's `spec.ref` was unusable — clear your stored ref so the next
   * run does not retry it. Fired before the next candidate is tried.
   */
  onRefUnusable?: (ref: string) => Promise<void> | void;
  /** Legacy/test seam: construct sandboxes from specs directly. */
  create?: (spec: SandboxSpec) => Sandbox;
}

/**
 * Open the sandbox for a piece of work, with continuity kept in a store:
 *   1. adopt the retained handle the store remembers (SAME workspace, edits
 *      intact) — when it is gone, the store is cleared;
 *   2. otherwise try each source in order (newest-usable ref first), reporting
 *      dead refs via `onRefUnusable` before the next candidate;
 *   3. whatever opens is written back to the store, so the next run adopts it.
 * The consumer supplies persistence; the package owns this policy.
 */
export async function openSandboxSession(
  args: OpenSandboxSessionArgs,
): Promise<Sandbox> {
  const make =
    args.create ?? ((spec: SandboxSpec) => args.provider.create(spec));
  const remember = async (sandbox: Sandbox) =>
    args.store.set(args.key, {
      retained: { id: sandbox.id, backend: sandbox.backend },
    });

  // 1. The retained sandbox this work-stream left behind.
  const session = await args.store.get(args.key);
  if (session?.retained) {
    // Adoption applies the fields a fresh start would (identity, env); the
    // ref is irrelevant — the workspace comes from the retained disk.
    const spec = args.sources.at(-1)?.spec ?? {};
    const adopted = args.create
      ? make({ ...spec, adopt: session.retained.id })
      : args.provider.adopt(session.retained, spec);
    try {
      await adopted.start();
      await remember(adopted);
      return adopted;
    } catch {
      await args.store.clear(args.key);
    }
  }

  // 2. Fresh candidates, newest-usable first.
  let lastError: unknown;
  for (const [index, source] of args.sources.entries()) {
    const fresh = make(source.spec);
    try {
      await fresh.start();
      await remember(fresh);
      return fresh;
    } catch (err) {
      lastError = err;
      if (index < args.sources.length - 1 && source.spec.ref)
        await args.onRefUnusable?.(source.spec.ref);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("openSandboxSession: no source could start");
}
