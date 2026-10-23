import { describe, expect, it } from "vitest";
import { dockerImagePublisher } from "../../src/sandbox/docker/image.js";
import { e2bImagePublisher } from "../../src/sandbox/e2b/image.js";
import { heyoImagePublisher } from "../../src/sandbox/heyo/image.js";

describe("image publishing contract", () => {
  it("docker builds and pushes a Dockerfile source", async () => {
    const calls: string[][] = [];
    const publisher = dockerImagePublisher({
      run: async (args) => {
        calls.push(args);
      },
    });

    const result = await publisher.publish({
      name: "ghcr.io/acme/agent:v1",
      source: { kind: "dockerfile", path: "Dockerfile", context: "." },
      buildArgs: { TARGET: "linux/arm64" },
    });

    expect(calls).toEqual([
      [
        "build",
        "-t",
        "ghcr.io/acme/agent:v1",
        "-f",
        "Dockerfile",
        "--build-arg",
        "TARGET=linux/arm64",
        ".",
      ],
      ["push", "ghcr.io/acme/agent:v1"],
    ]);
    expect(result).toEqual({
      provider: "docker",
      ref: "ghcr.io/acme/agent:v1",
      kind: "container",
      target: "sandbox-spec",
    });
  });

  it("docker can tag an existing image without pushing", async () => {
    const calls: string[][] = [];
    const publisher = dockerImagePublisher({
      run: async (args) => {
        calls.push(args);
      },
    });

    await publisher.publish({
      name: "acme/agent:v2",
      source: { kind: "image", image: "acme/agent:v1" },
      push: false,
    });

    expect(calls).toEqual([["tag", "acme/agent:v1", "acme/agent:v2"]]);
  });

  it("heyo pushes a rootfs and returns provider config", async () => {
    const calls: string[][] = [];
    const publisher = heyoImagePublisher({
      run: async (args) => {
        calls.push(args);
      },
    });

    const result = await publisher.publish({
      name: "team/agent:v1",
      source: { kind: "rootfs", path: "/tmp/rootfs.ext4" },
      public: true,
    });

    expect(calls).toEqual([
      [
        "artifact",
        "push",
        "/tmp/rootfs.ext4",
        "--tag",
        "team/agent:v1",
        "--public",
      ],
    ]);
    expect(result).toEqual({
      provider: "heyo",
      ref: "team/agent:v1",
      kind: "artifact",
      target: "provider-config",
      providerConfig: { image: "team/agent:v1", imageKind: "artifact" },
    });
  });

  it("heyo pushes a Dockerfile manifest with its context", async () => {
    const calls: string[][] = [];
    const publisher = heyoImagePublisher({
      run: async (args) => {
        calls.push(args);
      },
    });

    await publisher.publish({
      name: "team/agent-dockerfile:v1",
      source: { kind: "dockerfile", path: "Dockerfile", context: "." },
    });

    expect(calls[0]).toEqual([
      "artifact",
      "push-dockerfile",
      "Dockerfile",
      "--tag",
      "team/agent-dockerfile:v1",
      "--context",
      ".",
    ]);
  });

  it("e2b builds a template and returns a sandbox-spec ref", async () => {
    const publisher = e2bImagePublisher({
      build: async (source, name) => ({ name, source: source.kind } as never),
    });

    const result = await publisher.publish({
      name: "agent-template:v1",
      source: { kind: "image", image: "ubuntu:24.04" },
    });

    expect(result).toEqual({
      provider: "e2b",
      ref: "agent-template:v1",
      kind: "template",
      target: "sandbox-spec",
    });
  });

  it("rejects a source the provider cannot publish", async () => {
    const publisher = dockerImagePublisher({ run: async () => undefined });
    await expect(
      publisher.publish({
        name: "acme/rootfs:v1",
        source: { kind: "rootfs", path: "/tmp/rootfs.ext4" },
      }),
    ).rejects.toThrow(/docker image publisher accepts/);
  });
});
