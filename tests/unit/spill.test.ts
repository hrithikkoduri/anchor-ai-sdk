/**
 * Spill-at-truncation: over-long tool outputs are saved to the sandbox's
 * scratch dir, and the model-facing response stays head+tail plus a reference
 * — the clipped middle remains addressable instead of being lost.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import { spillOrTruncate, truncate } from "../../src/tools/truncate.js";

const big = Array.from(
  { length: 900 },
  (_, i) => `line ${i} ${"x".repeat(30)}`,
).join("\n");

describe("spillOrTruncate", () => {
  let rootDir: string;
  let sandbox: LocalSandbox;

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "anchor-spill-"));
    sandbox = new LocalSandbox({}, { rootDir, quiet: true });
    await sandbox.start();
  });

  afterAll(async () => {
    await sandbox.destroy();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("small outputs pass through untouched", async () => {
    expect(await spillOrTruncate("hello", { sandbox, label: "bash" })).toBe(
      "hello",
    );
  });

  it("without a sandbox, behaves exactly like truncate", async () => {
    const out = await spillOrTruncate(big, { label: "bash" });
    expect(out).toBe(truncate(big));
    expect(out).not.toContain("full output saved");
  });

  it("spills the full output into scratch and references it", async () => {
    const out = await spillOrTruncate(big, { sandbox, label: "bash" });
    expect(out).toContain("lines omitted");

    const match = out.match(/full output saved: (\/\S+\.txt)/);
    expect(match).toBeTruthy();
    const file = match![1]!;
    expect(file.startsWith(sandbox.scratch)).toBe(true);

    // The file holds the FULL output, byte-for-byte.
    const check = await sandbox.exec(`wc -c < ${file} && head -c 40 ${file}`);
    expect(check.exitCode).toBe(0);
    expect(Number(check.stdout.trim().split("\n")[0])).toBe(
      Buffer.byteLength(big, "utf8"),
    );
    expect(check.stdout).toContain("line 0");
  });
});
