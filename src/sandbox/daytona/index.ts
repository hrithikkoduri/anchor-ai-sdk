/**
 * Daytona — coming soon.
 *
 * A stub on purpose: the shape is visible, the factory fails loudly. Read
 * `../README.md` — "Adding a provider" lists everything a backend must build,
 * and `runSandboxConformance` (`anchor-ai-sdk/testing`) is the acceptance test
 * that decides when this adapter is done.
 */
import type { SandboxCapabilities, SandboxProvider } from "../provider.js";

/** Declared up front so a future adapter cannot silently claim previews. */
export const daytonaCapabilities: SandboxCapabilities = {
  fork: false,
  retain: false,
  remoteCheckpoint: false,
  egressControl: false,
  localPath: false,
  previewPort: false,
};

export interface DaytonaSandboxOptions {
  /** Daytona API key. */
  apiKey?: string;
  /** The workspace image. */
  image?: string;
}

export function daytona(_opts: DaytonaSandboxOptions = {}): SandboxProvider {
  throw new Error(
    "the daytona provider is not implemented yet (coming soon) — see src/sandbox/README.md for what a provider must do",
  );
}
