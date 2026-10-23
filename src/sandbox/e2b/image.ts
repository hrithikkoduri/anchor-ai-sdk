/** E2B's image publisher: a Dockerfile or base image becomes an E2B template.
 * E2B has no Docker-image-at-create; `Template.build()` is the publish step. */
import { Template, defaultBuildLogger, type LogEntry } from "e2b";
import {
  assertImageName,
  assertSourceSupported,
  type ImagePublisher,
  type ImagePublishRequest,
  type ImagePublishRuntime,
  type PublishedImage,
} from "../image.js";

export interface E2BImagePublisherOptions {
  apiKey?: string;
  domain?: string;
  cpuCount?: number;
  memoryMB?: number;
  /** Test seam; called instead of a real Template build. */
  build?: (
    source: ImagePublishRequest["source"],
    name: string,
  ) => Promise<{ name: string }>;
}

export function e2bImagePublisher(
  opts: E2BImagePublisherOptions = {},
): ImagePublisher {
  return {
    provider: "e2b",
    sources: ["dockerfile", "image"],
    async publish(
      request: ImagePublishRequest,
      runtime: ImagePublishRuntime = {},
    ): Promise<PublishedImage> {
      assertImageName(request.name);
      assertSourceSupported("e2b", ["dockerfile", "image"], request.source);
      if (request.push === false) {
        throw new Error(
          "E2B templates are published by Template.build(); `push: false` is not supported",
        );
      }
      if (request.buildArgs && Object.keys(request.buildArgs).length > 0) {
        throw new Error("E2B template publishing does not take Docker build args");
      }

      let template;
      if (request.source.kind === "dockerfile") {
        if (request.source.context) {
          throw new Error(
            "E2B fromDockerfile does not take a separate build context; use --from-image or a path-only Dockerfile",
          );
        }
        template = Template().fromDockerfile(request.source.path);
      } else if (request.source.kind === "image") {
        template = Template().fromImage(request.source.image);
      } else {
        throw new Error(
          "e2b image publishing accepts a Dockerfile or container image; use `heyo` for a rootfs",
        );
      }

      if (opts.build) {
        await opts.build(request.source, request.name);
      } else {
        await Template.build(template, request.name, {
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
          ...(opts.domain ? { domain: opts.domain } : {}),
          ...(opts.cpuCount ? { cpuCount: opts.cpuCount } : {}),
          ...(opts.memoryMB ? { memoryMB: opts.memoryMB } : {}),
          onBuildLogs: (entry: LogEntry) => {
            if (runtime.log) runtime.log(String(entry));
            else defaultBuildLogger()(entry);
          },
        });
      }

      return {
        provider: "e2b",
        ref: request.name,
        kind: "template",
        target: "sandbox-spec",
      };
    },
  };
}
