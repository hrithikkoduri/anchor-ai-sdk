/**
 * Daytona — coming soon.
 *
 * A stub on purpose: the shape is visible, the factory fails loudly. Read
 * `../README.md` — "Adding a provider" lists everything a backend must build,
 * and `runSandboxConformance` (`anchor-ai-sdk/testing`) is the acceptance test
 * that decides when this adapter is done.
 */
import type { SandboxProvider } from "../provider.js";

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
