/**
 * LocalSandbox conformance — the provider contract proven on the dev backend.
 *
 * The scenarios themselves live once in `@anchor/core/testing` and run against
 * any provider; both backends (local, heyo) pass the same file. Host-filesystem
 * extras that are specifically local — keep, root removal — stay here.
 */
import { mkdtempSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalSandbox, local } from "../../src/sandbox/local/index.js";
import type { SandboxSpec } from "../../src/sandbox/types.js";
import { runSandboxConformance } from "../../src/testing.js";

const rootDir = mkdtempSync(
  path.join(os.tmpdir(), "anchor-conformance-local-"),
);
const make = (spec: SandboxSpec = {}) =>
  new LocalSandbox(spec, { rootDir, quiet: true });

/** Existence probe that never throws. */
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

runSandboxConformance(local({ rootDir, quiet: true }));

describe("LocalSandbox extras (host filesystem semantics)", () => {
  it("keep: true preserves the workspace directory after destroy", async () => {
    const sb = make({ keep: true });
    await sb.start();
    await sb.destroy();
    expect(await exists(sb.root)).toBe(true);
  });

  it("destroy removes the workspace directory", async () => {
    const sb = make();
    await sb.start();
    await sb.destroy();
    expect(await exists(sb.root)).toBe(false);
  });

  it("adopt fails loudly when the retained sandbox is gone", async () => {
    const ghost = make({ adopt: "sb-anchor-does-not-exist" });
    await expect(ghost.start()).rejects.toThrow(/no workspace/);
  });
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});
