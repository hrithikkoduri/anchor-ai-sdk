/**
 * The one place that knows which Sandbox implementations exist.
 *
 * Production code asks for a sandbox here and only here; everything above this
 * line (`agent/`, `tools/`) depends solely on the `Sandbox` interface. The
 * swap between backends is therefore a single constructor call:
 *
 *   createSandbox(spec)              → HeyoSandbox (real microVM — step 4)
 *   createSandbox(spec, { local: true }) → LocalSandbox (dev/tests only)
 */
import { LocalSandbox } from "./local.js";
import type { Sandbox, SandboxSpec } from "./types.js";

export * from "./types.js";

export interface CreateSandboxOptions {
  /**
   * Run locally instead of in a microVM. Dev/test only — set by the `--local`
   * CLI flag or directly by tests; never by configuration.
   */
  local?: boolean;
}

export function createSandbox(spec: SandboxSpec, opts: CreateSandboxOptions = {}): Sandbox {
  if (opts.local) {
    return new LocalSandbox(spec);
  }
  // HeyoSandbox lands in BUILD_PLAN step 4.
  throw new Error("the heyo sandbox backend arrives in step 4 — pass { local: true } for now");
}
