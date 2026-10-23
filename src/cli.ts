#!/usr/bin/env node
/**
 * `anchor image publish` — the common image-publishing command.
 *
 *   anchor image publish --provider docker --name ghcr.io/acme/agent:v1 \
 *     --dockerfile Dockerfile --context .
 *
 *   anchor e2b image publish --name agent:v1 --from-image ubuntu:24.04
 *
 * Provider-specific publishers live on their sandbox subpaths; this command
 * loads only the selected one, so optional SDKs stay optional.
 */
import type {
  ImagePublisher,
  ImagePublishRequest,
  ImageSource,
  PublishedImage,
} from "./sandbox/image.js";

const PUBLISHERS = ["docker", "e2b", "heyo"] as const;
/**
 * Known providers. `daytona` and `local` are accepted so `anchor daytona image
 * publish` reaches the publisher lookup and fails with the real reason
 * (Daytona snapshot creation is a separate credentialed service), not with
 * "unknown command".
 */
const PROVIDERS = ["docker", "e2b", "heyo", "daytona", "local"] as const;
type ProviderName = (typeof PROVIDERS)[number];

interface Parsed {
  provider?: string;
  name?: string;
  source?: ImageSource;
  buildArgs: Record<string, string>;
  push: boolean;
  public: boolean;
  json: boolean;
  help: boolean;
}

function usage(): string {
  return `usage:
  anchor image publish --provider <docker|e2b|heyo> --name <tag>
    (--dockerfile <path> [--context <dir>] | --from-image <image> | --rootfs <path>)
    [--build-arg KEY=VALUE]... [--no-push] [--public] [--json]

  anchor <provider> image publish ...   # provider-first alias

Providers:
  docker  build/tag and push a container image
  e2b     build/publish an E2B template (from a Dockerfile or image)
  heyo    push a rootfs or Dockerfile manifest with heyctl

Credentials:
  Docker  uses the Docker CLI's existing login
  E2B     E2B_API_KEY (and optional E2B_DOMAIN)
  Heyo    heyctl's saved login (optional HEYCTL_BIN, HEYO_IMAGE_STORE)
`;
}

function isProvider(value: string | undefined): value is ProviderName {
  return !!value && (PROVIDERS as readonly string[]).includes(value);
}

function parse(argv: string[]): Parsed {
  const out: Parsed = {
    buildArgs: {},
    push: true,
    public: false,
    json: false,
    help: false,
  };
  let args = [...argv];
  if (args[0] === "image" && args[1] === "publish") {
    args = args.slice(2);
  } else if (isProvider(args[0]) && args[1] === "image" && args[2] === "publish") {
    out.provider = args[0];
    args = args.slice(3);
  } else if (isProvider(args[0]) && args[1] === "publish" && args[2] === "image") {
    out.provider = args[0];
    args = args.slice(3);
  } else if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    out.help = true;
    return out;
  } else {
    throw new Error(`unknown command\n\n${usage()}`);
  }

  let fromImage: string | undefined;
  let rootfs: string | undefined;
  let dockerfile: string | undefined;
  let context: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const value = (): string => {
      const v = args[i + 1];
      if (!v) throw new Error(`missing value for ${arg}`);
      i += 1;
      return v;
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--no-push") out.push = false;
    else if (arg === "--public") out.public = true;
    else if (arg === "--provider") out.provider = value();
    else if (arg === "--name") out.name = value();
    else if (arg === "--from-image") fromImage = value();
    else if (arg === "--rootfs") rootfs = value();
    else if (arg === "--dockerfile") dockerfile = value();
    else if (arg === "--context") context = value();
    else if (arg === "--build-arg") {
      const pair = value();
      const equals = pair.indexOf("=");
      if (equals <= 0) throw new Error(`--build-arg needs KEY=VALUE, got ${pair}`);
      out.buildArgs[pair.slice(0, equals)] = pair.slice(equals + 1);
    } else {
      throw new Error(`unknown option ${arg}\n\n${usage()}`);
    }
  }

  if (out.help) return out;
  const sources = [
    fromImage ? ({ kind: "image", image: fromImage } as const) : undefined,
    rootfs ? ({ kind: "rootfs", path: rootfs } as const) : undefined,
    dockerfile ? ({ kind: "dockerfile", path: dockerfile } as const) : undefined,
  ].filter((source) => source !== undefined);
  if (sources.length !== 1) {
    throw new Error(
      `choose exactly one of --dockerfile, --from-image, or --rootfs\n\n${usage()}`,
    );
  }
  if (context && !dockerfile) {
    throw new Error("--context requires --dockerfile");
  }
  if (dockerfile) out.source = { kind: "dockerfile", path: dockerfile, ...(context ? { context } : {}) };
  else if (rootfs) out.source = { kind: "rootfs", path: rootfs };
  else out.source = { kind: "image", image: fromImage! };
  return out;
}

async function loadPublisher(provider: string): Promise<ImagePublisher> {
  if (provider === "docker") {
    const { dockerImagePublisher } = await import("./sandbox/docker/image.js");
    return dockerImagePublisher({
      dockerBin: process.env.ANCHOR_DOCKER_BIN ?? process.env.DOCKER_BIN,
    });
  }
  if (provider === "e2b") {
    const { e2bImagePublisher } = await import("./sandbox/e2b/image.js");
    const cpu = process.env.E2B_CPU_COUNT;
    const memory = process.env.E2B_MEMORY_MB;
    return e2bImagePublisher({
      apiKey: process.env.E2B_API_KEY,
      domain: process.env.E2B_DOMAIN,
      ...(cpu ? { cpuCount: Number(cpu) } : {}),
      ...(memory ? { memoryMB: Number(memory) } : {}),
    });
  }
  if (provider === "heyo") {
    const { heyoImagePublisher } = await import("./sandbox/heyo/image.js");
    return heyoImagePublisher({
      heyctlBin: process.env.HEYCTL_BIN,
      imageStore: process.env.HEYO_IMAGE_STORE,
    });
  }
  throw new Error(
    `provider "${provider}" has no image publisher (supported: ${PUBLISHERS.join(", ")})`,
  );
}

function printResult(result: PublishedImage): void {
  console.log(`published ${result.kind} via ${result.provider}: ${result.ref}`);
  if (result.target === "sandbox-spec") {
    console.log(`use at sandbox init: { image: ${JSON.stringify(result.ref)} }`);
  } else {
    console.log(
      `use in provider config: ${JSON.stringify(result.providerConfig, null, 2)}`,
    );
  }
}

async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  if (!parsed.provider) throw new Error(`--provider is required\n\n${usage()}`);
  if (!parsed.name) throw new Error(`--name is required\n\n${usage()}`);
  if (!parsed.source) {
    throw new Error(
      `one of --dockerfile, --from-image, or --rootfs is required\n\n${usage()}`,
    );
  }
  const publisher = await loadPublisher(parsed.provider);
  const request: ImagePublishRequest = {
    name: parsed.name,
    source: parsed.source,
    buildArgs: parsed.buildArgs,
    push: parsed.push,
    public: parsed.public,
  };
  const result = await publisher.publish(request, {
    log: (line) => process.stderr.write(line),
  });
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
