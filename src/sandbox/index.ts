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

export function createSandbox(spec: SandboxSpec, opts: CreateSandboxOptions = {}): Sandbox {
  if (opts.local) {
    return new LocalSandbox(spec, typeof opts.local === "object" ? opts.local : {});
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
