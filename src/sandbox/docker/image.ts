/** Docker's implementation of the common image-publishing contract. */
import path from "node:path";
import { runCommand, type CommandRunOptions } from "../command.js";
import {
  assertImageName,
  assertSourceSupported,
  type ImagePublisher,
  type ImagePublishRequest,
  type ImagePublishRuntime,
  type PublishedImage,
} from "../image.js";

export interface DockerImagePublisherOptions {
  dockerBin?: string;
  /** Default for `request.push`; true means build then `docker push`. */
  push?: boolean;
  timeoutSecs?: number;
  /** Test seam: run the Docker CLI without a daemon. */
  run?: (args: string[], opts: CommandRunOptions) => Promise<void>;
}

export function dockerImagePublisher(
  opts: DockerImagePublisherOptions = {},
): ImagePublisher {
  const dockerBin = opts.dockerBin ?? "docker";
  const run = opts.run ?? ((args, runOpts) => runCommand(dockerBin, args, runOpts));
  return {
    provider: "docker",
    sources: ["dockerfile", "image"],
    async publish(
      request: ImagePublishRequest,
      runtime: ImagePublishRuntime = {},
    ): Promise<PublishedImage> {
      assertImageName(request.name);
      assertSourceSupported("docker", ["dockerfile", "image"], request.source);
      const timeoutSecs = opts.timeoutSecs ?? 1800;
      const runOpts: CommandRunOptions = {
        timeoutSecs,
        signal: runtime.signal,
        log: runtime.log,
      };

      if (request.source.kind === "dockerfile") {
        const context =
          request.source.context ?? path.dirname(request.source.path);
        const args = [
          "build",
          "-t",
          request.name,
          "-f",
          request.source.path,
        ];
        for (const [key, value] of Object.entries(request.buildArgs ?? {})) {
          args.push("--build-arg", `${key}=${value}`);
        }
        args.push(context);
        await run(args, runOpts);
      } else if (request.source.kind === "image") {
        if (request.source.image !== request.name) {
          await run(["tag", request.source.image, request.name], runOpts);
        }
      }

      const shouldPush = request.push ?? opts.push ?? true;
      if (shouldPush) await run(["push", request.name], runOpts);

      return {
        provider: "docker",
        ref: request.name,
        kind: "container",
        target: "sandbox-spec",
      };
    },
  };
}
