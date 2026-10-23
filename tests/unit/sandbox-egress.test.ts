/**
 * Egress is a benchmark control. A provider that cannot enforce it must say so
 * loudly: a run that believes it is isolated while it is not is worse than a
 * networked run.
 */
import { describe, expect, it } from "vitest";
import { docker } from "../../src/sandbox/docker/index.js";
import { local } from "../../src/sandbox/local/index.js";
import { e2b } from "../../src/sandbox/e2b/index.js";
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
  });
});

describe("persistent process streams", () => {
  it("advertises the capability only where it is implemented", () => {
    expect(local().capabilities.processStream).toBe(true);
    expect(docker({ image: "ubuntu:24.04" }).capabilities.processStream).toBe(
      true,
    );
    expect(heyo(heyoConfig).capabilities.processStream).toBe(true);
    expect(e2b({ template: "base", quiet: true }).capabilities.processStream).toBe(true);
  });
});

describe("image publishing declaration", () => {
  it("exposes a publisher only where the provider can publish", () => {
    expect(docker({ image: "ubuntu:24.04" }).capabilities.publishImage).toBe(true);
    expect(docker({ image: "ubuntu:24.04" }).imagePublisher?.provider).toBe("docker");
    expect(e2b({ template: "base", quiet: true }).capabilities.publishImage).toBe(true);
    expect(e2b({ template: "base", quiet: true }).imagePublisher?.provider).toBe("e2b");
    expect(heyo(heyoConfig).capabilities.publishImage).toBe(true);
    expect(heyo(heyoConfig).imagePublisher?.provider).toBe("heyo");
    expect(local().capabilities.publishImage).toBeUndefined();
    expect(local().imagePublisher).toBeUndefined();
  });

  it("declares previewPort explicitly and only E2B implements it", () => {
    expect(local().capabilities.previewPort).toBe(false);
    expect(docker({ image: "ubuntu:24.04" }).capabilities.previewPort).toBe(false);
    expect(heyo(heyoConfig).capabilities.previewPort).toBe(false);
    expect(e2b({ template: "base", quiet: true }).capabilities.previewPort).toBe(true);
  });
});
