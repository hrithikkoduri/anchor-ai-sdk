/**
 * The one place that knows which Sandbox implementations exist.
 *
 * Production code asks for a sandbox here and only here; everything above this
 * line (`agent/`, `tools/`) depends solely on the `Sandbox` interface. The
 * swap between backends is therefore a single constructor call:
 *
 *   createSandbox(spec, { heyo })        → HeyoSandbox (real microVM — default)
 *   createSandbox(spec, { local: true }) → LocalSandbox (dev/tests only)
 */
import { HeyoSandbox, type HeyoSandboxConfig } from "./heyo.js";
import { LocalSandbox, type LocalSandboxOptions } from "./local.js";
import type { Sandbox, SandboxSpec } from "./types.js";

export * from "./types.js";
export { HeyoSandbox, buildGuestCommand } from "./heyo.js";
export type { HeyoSandboxConfig } from "./heyo.js";
export { LocalSandbox } from "./local.js";
export type { LocalSandboxOptions } from "./local.js";

export interface CreateSandboxOptions {
  /**
   * Run locally instead of in a microVM. Dev/test only — set by the `--local`
   * CLI flag or directly by tests; never by configuration.
   */
  local?: boolean | LocalSandboxOptions;
  /** Heyo connection. Required unless `local` is set. */
  heyo?: HeyoSandboxConfig;
}

export function createSandbox(
  spec: SandboxSpec,
  opts: CreateSandboxOptions = {},
): Sandbox {
  if (opts.local) {
    return new LocalSandbox(
      spec,
      typeof opts.local === "object" ? opts.local : {},
    );
  }
  if (!opts.heyo?.token) {
    throw new Error(
      "the heyo backend needs a token — set HEYO_TOKEN in .env (and HEYO_NAMESPACE), or pass --local",
    );
  }
  if (spec.localPath) {
    // Fail fast instead of initializing an empty repo in the VM (learned the
    // hard way: a silent empty workspace cost a live agent run its whole trace).
    throw new Error(
      `localPath is a local-backend option — pass { local: true } (the --local flag), or give Heyo a repoUrl to clone`,
    );
  }
  return new HeyoSandbox(spec, opts.heyo);
}

/** A retained sandbox's coordinates — enough to re-open or release it later. */
export interface SandboxHandle {
  id: string;
  backend: "heyo" | "local";
}

export interface OpenSandboxArgs extends CreateSandboxOptions {
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
  /** Construction override (test factories). Defaults to `createSandbox`. */
  create?: (spec: SandboxSpec) => Sandbox;
}

/**
 * Open the sandbox for a piece of work — the lifecycle Sailor dogfoods:
 *   1. adopt the retained handle when one applies (SAME workspace, edits intact);
 *   2. on failure, report it (onRetainedGone) and build a fresh sandbox;
 *   3. when the fresh clone's `ref` is unusable, report it (onRefUnusable) and
 *      retry `fallbackSpec`.
 * The callbacks are bookkeeping for the owner (clearing DB pointers); they
 * must not throw. A mismatched retained backend is skipped silently — it is
 * not gone, just not usable in this configuration.
 */
export async function openSandbox(args: OpenSandboxArgs): Promise<Sandbox> {
  const make =
    args.create ?? ((spec: SandboxSpec) => createSandbox(spec, args));
  const wantBackend: "heyo" | "local" = args.local ? "local" : "heyo";
  if (args.adopt && args.adopt.backend === wantBackend) {
    const adopted = make({ ...args.spec, adopt: args.adopt.id });
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
 * `CreateSandboxOptions` the sandbox was created with (a local backend's
 * `rootDir` matters here).
 */
export async function releaseSandbox(
  handle: SandboxHandle,
  opts: CreateSandboxOptions = {},
): Promise<void> {
  const spec: SandboxSpec = { adopt: handle.id };
  const sandbox =
    handle.backend === "local"
      ? new LocalSandbox(spec, typeof opts.local === "object" ? opts.local : {})
      : new HeyoSandbox(spec, requiredHeyoConfig(opts));
  await sandbox.destroy();
}

function requiredHeyoConfig(opts: CreateSandboxOptions): HeyoSandboxConfig {
  if (!opts.heyo?.token) {
    throw new Error(
      "releaseSandbox: a heyo token is required for the heyo backend — set HEYO_TOKEN in .env",
    );
  }
  return opts.heyo;
}
