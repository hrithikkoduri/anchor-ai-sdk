/**
 * Unit tests for the Heyo adapter's load-bearing pieces — no network needed.
 * The guest-side `timeout` wrapper is what keeps a hung command from burning
 * a VM after the API call gives up, and the embedded `cd` is what makes
 * commands run in the workspace even though Heyo starts every exec in `/`.
 */
import { describe, expect, it } from "vitest";
import { buildGuestCommand } from "../../src/sandbox/heyo.js";

describe("buildGuestCommand", () => {
  it("embeds the cd and wraps in a guest-side timeout that kills hard", () => {
    const wrapped = buildGuestCommand("npm test", 300, "/workspace/repo");
    expect(wrapped).toBe(`timeout -k 5 300 bash -c 'cd '\\''/workspace/repo'\\'' && npm test'`);
  });

  it("single-quotes the command so shell metacharacters stay inert", () => {
    const wrapped = buildGuestCommand("echo $HOME && rm -rf /tmp/x", 10, "/workspace/repo");
    expect(wrapped).toContain(`&& echo $HOME && rm -rf /tmp/x'`);
  });

  it("escapes embedded single quotes the POSIX way", () => {
    const wrapped = buildGuestCommand(`echo 'hi'`, 10, "/workspace/repo");
    expect(wrapped).toContain(`&& echo '\\''hi'\\'''`);
  });

  it("never lets a command escape into the outer shell", () => {
    const evil = `x'; kill -9 $$; echo '`;
    const wrapped = buildGuestCommand(evil, 10, "/workspace/repo");
    // Every quote in the payload is escaped — the whole thing stays inside one argument.
    const payload = wrapped.slice(wrapped.indexOf("bash -c ") + "bash -c ".length);
    expect(payload.startsWith("'")).toBe(true);
    expect(payload.endsWith("'")).toBe(true);
    expect(payload).toContain(`'\\''`);
  });
});
