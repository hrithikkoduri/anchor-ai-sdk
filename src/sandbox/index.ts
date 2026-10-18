/**
 * The sandbox layer's entry points: providers and their lifecycle.
 *
 * Production code opens sandboxes through a `SandboxProvider` (or the legacy
 * options shape, bridged by `providerFor`) and never depends on concrete
 * classes. The classes themselves — and their SDKs — live on subpaths:
 *
 *   @anchor/core/sandbox/heyo   → heyo(), HeyoSandbox (imports @heyocomputer/hws)
 *   @anchor/core/sandbox/local  → local(), LocalSandbox
 *
 * The root export deliberately keeps only types from those modules (erased at
 * compile time), so a consumer that uses neither pays for neither.
 */
import type { Sandbox, SandboxSpec } from "./types.js";
import type { SandboxHandle, SandboxProvider } from "./provider.js";
import { providerFor, type CreateSandboxOptions } from "./providers.js";

export * from "./types.js";
export * from "./provider.js";
export { heyo, local, providerFor } from "./providers.js";
export type { CreateSandboxOptions } from "./providers.js";
export type { HeyoSandboxConfig } from "./heyo.js";
export type { LocalSandboxOptions } from "./local.js";

/**
 * A fresh sandbox with minimal validation. Prefer passing a provider
 * directly (`heyo({...}).create(spec)`) in new code; the legacy options
 * shape (`{ local } | { heyo }`) keeps older consumers working.
 */
export function createSandbox(
  spec: SandboxSpec,
  opts: CreateSandboxOptions = {},
): Sandbox {
  if (!opts.local && spec.localPath) {
    // Fail fast instead of initializing an empty repo in the VM (learned the
    // hard way: a silent empty workspace cost a live agent run its trace).
    throw new Error(
      `localPath is a local-backend option — pass { local: true } (the --local flag), or give Heyo a repoUrl to clone`,
    );
  }
  return providerFor(opts).create(spec);
}

export interface OpenSandboxArgs extends CreateSandboxOptions {
  /** The provider to open with. Defaults to the legacy options shape. */
  provider?: SandboxProvider;
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
  /** Legacy test seam: construct sandboxes from specs directly. */
  create?: (spec: SandboxSpec) => Sandbox;
}

/**
 * Open the sandbox for a piece of work — the lifecycle Sailor dogfoods:
 *   1. adopt the retained handle when one applies (SAME workspace, edits intact);
 *   2. on failure, report it (onRetainedGone) and build a fresh sandbox;
 *   3. when the fresh clone's `ref` is unusable, report it (onRefUnusable) and
 *      retry `fallbackSpec`.
 * The callbacks are bookkeeping for the owner (clearing DB pointers); they
 * must not throw. A handle owned by a different provider is skipped silently —
 * it is not gone, just not usable in this configuration.
 */
export async function openSandbox(args: OpenSandboxArgs): Promise<Sandbox> {
  // The legacy test seam (`create`) needs no provider at all — resolve one
  // only when it will actually be used.
  const provider =
    args.provider ?? (args.create ? undefined : providerFor(args));
  const make = args.create ?? ((spec: SandboxSpec) => provider!.create(spec));
  // Legacy seam matches the handle like before (options-derived backend);
  // the provider path requires the handle to be owned by this provider.
  const owner = provider?.name ?? (args.local ? "local" : "heyo");
  if (args.adopt && args.adopt.backend === owner) {
    const adopted = args.create
      ? make({ ...args.spec, adopt: args.adopt.id })
      : provider!.adopt(args.adopt, args.spec);
    try {
      await adopted.start();
      return adopted;
    } catch {
      await args.onRetainedGone?.(args.adopt);
    }
  }
  const fresh = make(args.spec);
  try {
    await fresh.start();
    return fresh;
  } catch (err) {
    if (!args.spec.ref || !args.fallbackSpec) throw err;
    await args.onRefUnusable?.(args.spec.ref);
    const fallback = make(args.fallbackSpec);
    await fallback.start();
    return fallback;
  }
}

/**
 * Release a retained sandbox: destroy it by handle alone — no workspace spec,
 * no start(). A sandbox that is already gone is not an error. Pass the same
 * provider (or legacy options) the sandbox was created with — a local
 * backend's `rootDir` matters here.
 */
export async function releaseSandbox(
  handle: SandboxHandle,
  opts: CreateSandboxOptions & { provider?: SandboxProvider } = {},
): Promise<void> {
  const provider = opts.provider ?? providerFor(opts);
  await provider.release(handle);
}
