/** Heyo's image publisher: upload a rootfs or Dockerfile manifest to the
 * namespace artifact store through the `heyctl` CLI. The SDK does not own a
 * registry token; `heyctl` uses the login it already stores. */
import { runCommand, type CommandRunOptions } from "../command.js";
import {
  assertImageName,
  assertSourceSupported,
  type ImagePublisher,
  type ImagePublishRequest,
  type ImagePublishRuntime,
  type PublishedImage,
} from "../image.js";

export interface HeyoImagePublisherOptions {
  heyctlBin?: string;
  /** Store URL for the returned provider config; Heyo defaults to its hub. */
  imageStore?: string;
  timeoutSecs?: number;
  /** Test seam. */
  run?: (args: string[], opts: CommandRunOptions) => Promise<void>;
}

export function heyoImagePublisher(
  opts: HeyoImagePublisherOptions = {},
): ImagePublisher {
  const heyctlBin = opts.heyctlBin ?? "heyctl";
  const run = opts.run ?? ((args, runOpts) => runCommand(heyctlBin, args, runOpts));
  return {
    provider: "heyo",
    sources: ["rootfs", "dockerfile"],
    async publish(
      request: ImagePublishRequest,
      runtime: ImagePublishRuntime = {},
    ): Promise<PublishedImage> {
      assertImageName(request.name);
      assertSourceSupported("heyo", ["rootfs", "dockerfile"], request.source);
      if (request.buildArgs && Object.keys(request.buildArgs).length > 0) {
        throw new Error("heyo artifact publishing does not take build args");
      }
      const runOpts: CommandRunOptions = {
        timeoutSecs: opts.timeoutSecs ?? 1800,
        signal: runtime.signal,
        log: runtime.log,
      };

      if (request.source.kind === "rootfs") {
        const args = [
          "artifact",
          "push",
          request.source.path,
          "--tag",
          request.name,
        ];
        if (request.public) args.push("--public");
        await run(args, runOpts);
        return {
          provider: "heyo",
          ref: request.name,
          kind: "artifact",
          target: "provider-config",
          providerConfig: {
            image: request.name,
            imageKind: "artifact",
            ...(opts.imageStore ? { imageStore: opts.imageStore } : {}),
          },
        };
      }

      if (request.source.kind === "dockerfile") {
        const args = [
          "artifact",
          "push-dockerfile",
          request.source.path,
          "--tag",
          request.name,
        ];
        if (request.source.context) {
          args.push("--context", request.source.context);
        }
        await run(args, runOpts);
        return {
          provider: "heyo",
          ref: request.name,
          kind: "artifact",
          target: "provider-config",
          providerConfig: {
            image: request.name,
            imageKind: "dockerfile",
            ...(opts.imageStore ? { imageStore: opts.imageStore } : {}),
          },
        };
      }

      throw new Error(
        "heyo image publishing accepts a rootfs or Dockerfile; use `docker` or `e2b` for a container image",
      );
    },
  };
}
