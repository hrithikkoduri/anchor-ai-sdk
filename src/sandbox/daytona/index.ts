/**
 * Daytona — coming soon.
 *
 * A stub on purpose: the shape is visible, the factory fails loudly. Read
 * `../README.md` — "Adding a provider" lists everything a backend must build,
 * and `runSandboxConformance` (`@anchor/core/testing`) is the acceptance test
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
    "the daytona provider is not implemented yet — see packages/core/src/sandbox/README.md (coming soon)",
  );
}
