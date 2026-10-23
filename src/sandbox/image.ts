/**
 * The optional image-publishing seam. A provider that can turn a Dockerfile,
 * an existing image, or a rootfs into its own deployable artifact implements
 * this; consumers then use the returned `ref` at sandbox creation.
 *
 * This is deliberately separate from `Sandbox`: building and publishing an
 * image is a slow, credentialed deployment step, not something `start()` does.
 * The provider still owns its native vocabulary; the common contract only
 * names the source and the result.
 */

/** Where a published artifact came from. */
export type ImageSource =
  | { kind: "dockerfile"; path: string; context?: string }
  | { kind: "image"; image: string }
  | { kind: "rootfs"; path: string };

export interface ImagePublishRequest {
  /** Target name or tag in the provider's registry. */
  name: string;
  source: ImageSource;
  /** Docker/E2B build arguments; providers that cannot honor them reject. */
  buildArgs?: Record<string, string>;
  /** Ask the provider to publish after building. Default: true. */
  push?: boolean;
  /** Heyo only: make the artifact repository public on the hub. */
  public?: boolean;
}

export type PublishedImage =
  | {
      provider: string;
      /** Pass this to `SandboxSpec.image` when target is sandbox-spec. */
      ref: string;
      kind: "container" | "template" | "artifact";
      target: "sandbox-spec";
    }
  | {
      provider: string;
      /** Pass this plus `providerConfig` to the provider factory. */
      ref: string;
      kind: "container" | "template" | "artifact";
      target: "provider-config";
      providerConfig: Record<string, unknown>;
    };

export interface ImagePublishRuntime {
  signal?: AbortSignal;
  /** Build/push output; callers route this to stderr or a log sink. */
  log?: (line: string) => void;
}

export interface ImagePublisher {
  /** Matches the provider name; stored verbatim in results. */
  provider: string;
  /** Source kinds this publisher accepts; reject the rest explicitly. */
  sources: readonly ImageSource["kind"][];
  publish(
    request: ImagePublishRequest,
    runtime?: ImagePublishRuntime,
  ): Promise<PublishedImage>;
}

export function assertImageName(name: string): void {
  if (!name.trim()) throw new Error("image name must not be empty");
  if (/\s/.test(name)) throw new Error("image name must not contain whitespace");
}

export function assertSourceSupported(
  provider: string,
  sources: readonly ImageSource["kind"][],
  source: ImageSource,
): void {
  if (!sources.includes(source.kind)) {
    throw new Error(
      `${provider} image publisher accepts ${sources.join(", ")}; ` +
        `cannot publish a ${source.kind} source`,
    );
  }
}
