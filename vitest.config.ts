import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // These tests run REAL sandboxes that spawn git subprocesses (init, clone,
    // commit) — the 5s default is a coin flip on a loaded machine. 20s still
    // fails fast on genuine hangs.
    testTimeout: 20_000,
  },
});
