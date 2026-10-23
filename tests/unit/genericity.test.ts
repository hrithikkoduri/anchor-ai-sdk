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
const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const TESTS = path.join(PACKAGE, "tests");

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
      // Two deliberate exceptions: relaying the host env to a local
      // subprocess is execution, not configuration; the CLI is the product
      // boundary where credentials enter from the environment.
      .filter((file) => file !== "sandbox/local/index.ts" && file !== "cli.ts");
    expect(offenders).toEqual([]);
  });

  it("imports no product infrastructure", () => {
    const forbidden = /from\s+["'](?:.*\/apps\/|pg|ioredis|bullmq|drizzle-orm)/;
    const offenders = files(SRC)
      .filter((file) => forbidden.test(content(file)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("keeps the Heyo SDK behind its subpath (sandbox/heyo/)", () => {
    // Imports only — a doc comment may legitimately name the SDK.
    const forbidden =
      /from\s+["']@heyocomputer\/hws["']|import\(\s*["']@heyocomputer\/hws["']/;
    const offenders = files(SRC)
      .filter((file) => forbidden.test(content(file)))
      .map(rel)
      // The subpath's own files: heyo/index.ts is the SDK boundary,
      // heyo/secret.ts is Heyo admin machinery — both reachable only via
      // /sandbox/heyo.
      .filter(
        (file) =>
          file !== "sandbox/heyo/index.ts" && file !== "sandbox/heyo/secret.ts",
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

  it("names no product — source and fixtures ship standalone", () => {
    // Overfit smells like a name: a consumer's product noun in package code
    // or fixtures means the abstraction learned its first customer instead of
    // the job. The fix for a hit is to make the code generic or move it to
    // the product — never to whitelist a file. Extend the pattern as new
    // consumers leak. (Ecosystem nouns are fine: the docker adapter may
    // document SWE-bench images — interoperability, not product.)
    const forbidden = /\bsailor\b/i;
    // Positive control: the rule can actually fire.
    expect(forbidden.test("the Sailor app")).toBe(true);
    expect(forbidden.test("an anchor test")).toBe(false);
    // The rule cannot read itself: its pattern and control contain the noun
    // by construction.
    const guardFile = path.join(TESTS, "unit", "genericity.test.ts");
    const offenders = [...files(SRC), ...files(TESTS)]
      .filter((file) => file !== guardFile)
      .filter((file) => forbidden.test(content(file)))
      .map((file) => path.relative(PACKAGE, file));
    expect(offenders).toEqual([]);
  });
});
