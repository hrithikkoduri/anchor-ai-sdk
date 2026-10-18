/**
 * The legacy options → provider bridge (`{ local } | { heyo }`).
 *
 * The factories themselves live with their classes — `heyo.ts`, `local.ts` —
 * and are re-exported here for convenience. This module is only reachable
 * through `openSandbox`/`releaseSandbox`'s legacy path, loaded lazily, so the
 * root entry never drags in a provider SDK.
 */
import { heyo, type HeyoSandboxConfig } from "./heyo.js";
import { local, type LocalSandboxOptions } from "./local.js";
import type { SandboxProvider } from "./provider.js";

export { heyo } from "./heyo.js";
export { local } from "./local.js";

/** The legacy options shape — drop it in favor of explicit providers. */
export type CreateSandboxOptions = {
  /**
   * Run locally instead of in a microVM. Dev/test only — set by the `--local`
   * CLI flag or directly by tests; never by configuration.
   */
  local?: boolean | LocalSandboxOptions;
  /** Heyo connection. Required unless `local` is set. */
  heyo?: HeyoSandboxConfig;
};

export function providerFor(opts: CreateSandboxOptions): SandboxProvider {
  if (opts.local)
    return local(typeof opts.local === "object" ? opts.local : {});
  if (!opts.heyo?.token) {
    throw new Error(
      "the heyo backend needs a token — set HEYO_TOKEN in .env (and HEYO_NAMESPACE), or pass --local",
    );
  }
  return heyo(opts.heyo);
}
