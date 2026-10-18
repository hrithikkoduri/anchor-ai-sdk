/**
 * Genericity guards — the package must stay consumer-neutral. These are
 * executable rules, not prose: if one fires, something product-shaped leaked
 * into `packages/core`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return files(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const content = (file: string) => readFileSync(file, "utf8");
const rel = (file: string) => path.relative(SRC, file);

describe("package genericity", () => {
  it("never reads process.env (the local backend's documented passthrough aside)", () => {
    const offenders = files(SRC)
      .filter((file) => content(file).includes("process.env"))
      .map(rel)
      // The one deliberate exception: relaying the host env to a local
      // subprocess is execution, not configuration.
      .filter((file) => file !== "sandbox/local.ts");
    expect(offenders).toEqual([]);
  });

  it("imports no product infrastructure", () => {
    const forbidden = /from\s+["'](?:.*\/apps\/|pg|ioredis|bullmq|drizzle-orm)/;
    const offenders = files(SRC)
      .filter((file) => forbidden.test(content(file)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("keeps the Heyo SDK behind its subpath (sandbox/heyo.ts)", () => {
    // Imports only — a doc comment may legitimately name the SDK.
    const forbidden =
      /from\s+["']@heyocomputer\/hws["']|import\(\s*["']@heyocomputer\/hws["']/;
    const offenders = files(SRC)
      .filter((file) => forbidden.test(content(file)))
      .map(rel)
      // The subpath's own files: heyo.ts is the SDK boundary, heyo-secret.ts
      // is Heyo admin machinery — both reachable only via /sandbox/heyo.
      .filter(
        (file) =>
          file !== "sandbox/heyo.ts" && file !== "sandbox/heyo-secret.ts",
      );
    expect(offenders).toEqual([]);
  });

  it("keeps the test framework behind the testing entry (src/testing.ts)", () => {
    // The conformance suite is the one entry allowed to load vitest; the
    // engine, tools, and sandbox adapters must never depend on a test runner.
    const forbidden = /from\s+["']vitest["']|import\(\s*["']vitest["']/;
    const offenders = files(SRC)
      .filter((file) => forbidden.test(content(file)))
      .map(rel)
      .filter((file) => file !== "testing.ts");
    expect(offenders).toEqual([]);
  });
});
