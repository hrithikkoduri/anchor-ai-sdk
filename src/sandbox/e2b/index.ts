/**
 * E2B — coming soon.
 *
 * A stub on purpose: the shape is visible, the factory fails loudly. Read
 * `../README.md` — "Adding a provider" lists everything a backend must build,
 * and `runSandboxConformance` (`@anchor/core/testing`) is the acceptance test
 * that decides when this adapter is done.
 */
import type { SandboxProvider } from "../provider.js";

export interface E2BSandboxOptions {
  /** E2B API key. */
  apiKey?: string;
  /** Template/snapshot the sandbox starts from. */
  template?: string;
}

export function e2b(_opts: E2BSandboxOptions = {}): SandboxProvider {
  throw new Error(
    "the e2b provider is not implemented yet (coming soon) — see src/sandbox/README.md for what a provider must do",
  );
}
