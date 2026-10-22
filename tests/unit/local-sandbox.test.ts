/**
 * LocalSandbox conformance — the provider contract proven on the dev backend.
 *
 * The scenarios themselves live once in `anchor-ai-sdk/testing` and run against
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

  it("signal kills a running command promptly and reports cancelled", async () => {
    const sb = make();
    await sb.start();
    const marker = `abort-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = sb.exec(`sleep 9999; touch ${marker}`, {
      timeoutSecs: 3600,
      signal: controller.signal,
    });
    // Give the child a moment to spawn, then cancel the run.
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    const elapsedMs = Date.now() - startedAt;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(elapsedMs).toBeLessThan(500);
    // The process group is dead: a fresh exec confirms nothing is still
    // running under our command (`[9]999` so pgrep never matches itself).
    const probe = await sb.exec(`pgrep -f 'sleep 999[9]' || echo dead`);
    expect(probe.stdout.trim()).toBe("dead");
    expect(
      (await sb.exec(`ls ${marker} 2>/dev/null || echo gone`)).stdout.trim(),
    ).toBe("gone");
    await sb.destroy();
  });

  it("without a signal, exec behavior is unchanged", async () => {
    const sb = make();
    await sb.start();
    const r = await sb.exec("echo untouched");
    expect(r.exitCode).toBe(0);
    expect(r.cancelled).toBeUndefined();
    await sb.destroy();
  });
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});
