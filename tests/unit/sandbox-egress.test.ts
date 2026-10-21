/**
 * Egress is a benchmark control. A provider that cannot enforce it must say so
 * loudly: a run that believes it is isolated while it is not is worse than a
 * networked run.
 */
import { describe, expect, it } from "vitest";
import { docker } from "../../src/sandbox/docker/index.js";
import { local } from "../../src/sandbox/local/index.js";
import { e2b } from "../../src/sandbox/e2b/index.js";
import { daytona } from "../../src/sandbox/daytona/index.js";
import { heyo } from "../../src/sandbox/heyo/index.js";

const heyoConfig = {
  token: "test",
  server: "https://example.test",
  namespace: "test",
  image: "heyo/bun:latest",
  sizeClass: "small" as const,
  diskSizeGb: 4,
};

describe("egress control", () => {
  it("docker declares the capability", () => {
    expect(docker({ image: "ubuntu:24.04" }).capabilities.egressControl).toBe(
      true,
    );
  });

  it("the other providers do not claim it", () => {
    expect(local().capabilities.egressControl).toBe(false);
    expect(heyo(heyoConfig).capabilities.egressControl).toBe(false);
    expect(e2b({ template: "base", quiet: true }).capabilities.egressControl).toBe(
      false,
    );
    expect(
      daytona({ image: "debian:12", quiet: true }).capabilities.egressControl,
    ).toBe(false);
  });

  it("rejects egress none instead of running with network", async () => {
    await expect(
      local().create({ egress: "none" }).start(),
    ).rejects.toThrow(/no egress control/);

    await expect(
      heyo(heyoConfig).create({ egress: "none" }).start(),
    ).rejects.toThrow(/no egress control/);

    await expect(
      e2b({ template: "base", quiet: true }).create({ egress: "none" }).start(),
    ).rejects.toThrow(/no egress control/);

    await expect(
      daytona({ image: "debian:12", quiet: true })
        .create({ egress: "none" })
        .start(),
    ).rejects.toThrow(/no egress control/);
  });
});
