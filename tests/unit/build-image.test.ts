import { describe, expect, it } from "vitest";
import { daytona } from "../../src/sandbox/daytona/index.js";
import { e2b } from "../../src/sandbox/e2b/index.js";
import { heyo } from "../../src/sandbox/heyo/index.js";
import type {
  ImageBuildSpec,
  SandboxProvider,
} from "../../src/sandbox/provider.js";

/** Providers that declare buildImage must implement it. */
function withBuildImage(provider: SandboxProvider): {
  provider: SandboxProvider;
  buildImage: NonNullable<SandboxProvider["buildImage"]>;
} {
  expect(provider.capabilities.buildImage).toBe(true);
  if (!provider.buildImage) throw new Error("buildImage declared but missing");
  return { provider, buildImage: provider.buildImage };
}

describe("buildImage (unified publish surface)", () => {
  it("daytona routes a build through createSnapshot and returns the name", async () => {
    const built: string[] = [];
    const provider = daytona({
      quiet: true,
      clientFactory: {
        create: async () => {
          throw new Error("create should not run during buildImage");
        },
        get: async () => {
          throw new Error("get should not run during buildImage");
        },
        createSnapshot: async (name) => {
          built.push(name);
          return name;
        },
        snapshotExists: async () => false,
      },
    });
    const { buildImage } = withBuildImage(provider);
    const result = await buildImage({
      name: "anchor-test",
      fromImage: "debian:bookworm",
      run: ["apt-get install -y git"],
    });
    expect(result).toEqual({ name: "anchor-test", provider: "daytona" });
    expect(built).toEqual(["anchor-test"]);
  });

  it("daytona rejects a spec with neither source", async () => {
    const { buildImage } = withBuildImage(daytona({ quiet: true }));
    await expect(
      buildImage({ name: "x" } as ImageBuildSpec),
    ).rejects.toThrow(/fromImage \/ dockerfile/);
  });

  it("daytona rejects both sources at once", async () => {
    const { buildImage } = withBuildImage(daytona({ quiet: true }));
    await expect(
      buildImage({
        name: "x",
        fromImage: "debian:bookworm",
        dockerfile: "Dockerfile",
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("e2b declares buildImage (the template path is SDK-side)", () => {
    expect(e2b({}).capabilities.buildImage).toBe(true);
  });

  it("heyo rejects registry/dockerfile sources with the honest reason", async () => {
    const provider = heyo({
      server: "https://heyo.test",
      token: "t",
      namespace: "ns",
      image: "heyo/bun:latest",
      sizeClass: "small",
      diskSizeGb: 20,
    });
    const { buildImage } = withBuildImage(provider);
    await expect(
      buildImage({ name: "x", fromImage: "debian:bookworm" }),
    ).rejects.toThrow(/heyctl artifact push/);
    await expect(
      buildImage({ name: "x", dockerfile: "Dockerfile" }),
    ).rejects.toThrow(/heyctl artifact push/);
  });

  it("local and docker declare no buildImage capability", async () => {
    const { local } = await import("../../src/sandbox/local/index.js");
    const { docker } = await import("../../src/sandbox/docker/index.js");
    expect(local({ quiet: true }).capabilities.buildImage).toBe(false);
    expect(docker({ quiet: true }).capabilities.buildImage).toBe(false);
  });
});
