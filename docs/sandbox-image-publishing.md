# Sandbox image publishing

Anchor can build and publish a sandbox image through one provider-neutral
contract, then use the returned reference when the sandbox is created. The
implementation is provider-native: Docker publishes a container image, E2B
publishes a template, and Heyo publishes an artifact. There is no shared
Anchor registry.

Status: v0.1.8. This page is the source material for the sandbox/image section
of the documentation website.

## What stays the same

`SandboxSpec.image` is the per-sandbox image override:

```ts
const sandbox = provider.create({
  repoUrl: "https://github.com/acme/app.git",
  image: "the-published-ref",
});
```

Support is intentionally provider-specific:

| Provider | Per-sandbox `spec.image` | What the value means |
| --- | --- | --- |
| Docker | Yes | A container image name/tag. |
| E2B | Yes | An E2B template name or ID, **not** a Docker image. |
| Heyo | Artifact only | An artifact ref when `heyo({ imageKind: "artifact" })`. Dockerfile/git builds are provider-level and reject per-sandbox images. |
| Local | No | Host filesystem only; use `localPath` or Docker. |
| Daytona | Not yet | Stub only. |

Registry publishing is an explicit step before the run. Docker and E2B boot a
prepared image/template; Heyo may still build its configured Dockerfile/git
source during `start()`. Uploading a Heyo Dockerfile manifest publishes a
recipe, not a ready-to-boot rootfs.

## Common contract

Providers that can publish set:

```ts
provider.capabilities.publishImage === true
```

and expose:

```ts
provider.imagePublisher?.publish(request)
```

The request accepts one source:

```ts
type ImageSource =
  | { kind: "dockerfile"; path: string; context?: string }
  | { kind: "image"; image: string }
  | { kind: "rootfs"; path: string };
```

The result says where the ref belongs:

- `target: "sandbox-spec"` — pass `ref` as `SandboxSpec.image`
- `target: "provider-config"` — merge `providerConfig` into the provider factory

Programmatic use:

```ts
const published = await provider.imagePublisher!.publish({
  name: "acme/agent:v1",
  source: { kind: "dockerfile", path: "Dockerfile", context: "." },
});

if (published.target === "sandbox-spec") {
  const sandbox = provider.create({ image: published.ref });
}
```

Each publisher declares its accepted source kinds in `publisher.sources`.
Unsupported sources fail loudly instead of silently building the wrong thing.

## CLI

The package installs an `anchor` binary:

```bash
anchor image publish --provider docker --name ghcr.io/acme/agent:v1 \
  --dockerfile Dockerfile --context .

anchor e2b image publish --name acme-agent:v1 \
  --from-image ubuntu:24.04

anchor heyo image publish --name acme/agent:v1 \
  --rootfs ./rootfs.ext4 --public
```

Both forms are equivalent:

```bash
anchor image publish --provider e2b ...
anchor e2b image publish ...
anchor e2b publish image ...
```

Run `anchor image publish --help` for the full flag list. Use `--json` for
machine-readable output and `--no-push` for Docker build-only workflows.

## Docker

### Prerequisites

- Docker CLI and a running daemon.
- Registry authentication when pushing: `docker login`.
- `ANCHOR_DOCKER_BIN` or `DOCKER_BIN` when the binary is not on `PATH`.

### Publish

```bash
anchor image publish \
  --provider docker \
  --name ghcr.io/acme/agent:v1 \
  --dockerfile Dockerfile \
  --context .
```

The publisher runs:

```text
docker build -t <name> -f <Dockerfile> [--build-arg K=V]... <context>
docker push <name>
```

Use `--no-push` to stop after the build, or publish an existing image:

```bash
anchor image publish --provider docker \
  --name acme/agent:v2 \
  --from-image acme/agent:v1
```

### Use it

```ts
const provider = docker({ image: "ghcr.io/acme/agent:v1" });
// or per sandbox:
const sandbox = provider.create({ image: "ghcr.io/acme/agent:v1" });
```

## E2B

E2B boots templates, not arbitrary Docker images. `Template.build()` is the
publish step.

### Prerequisites

- Install the optional `e2b` peer dependency.
- `E2B_API_KEY` (and optionally `E2B_DOMAIN`).
- `E2B_CPU_COUNT` / `E2B_MEMORY_MB` for template sizing.

### Publish from a base image

```bash
anchor e2b image publish \
  --name acme-agent:v1 \
  --from-image ubuntu:24.04
```

### Publish from a Dockerfile

```bash
anchor e2b image publish \
  --name acme-agent:v1 \
  --dockerfile ./Dockerfile
```

E2B's `fromDockerfile` does not accept a separate build context. `--context`
is rejected; use `--from-image` or a self-contained Dockerfile instead.

E2B always publishes a template, so `--no-push` is rejected.

### Use it

```ts
const provider = e2b({ template: "acme-agent:v1" });
// or per sandbox:
const sandbox = provider.create({ image: "acme-agent:v1" });
```

Do not pass a Docker image name such as `ubuntu:24.04` here; it must be the E2B
template name produced by the publish step.

## Heyo

Heyo publishes to its namespace artifact store through the external `heyctl`
CLI. `heyctl` is not bundled with Anchor.

### Prerequisites

- Install `heyctl`.
- Log in to the target namespace with `heyctl login`.
- `heyctl`'s current published builds are Linux x86_64.
- Set `HEYCTL_BIN` if it is not on `PATH`.

### Publish a rootfs

```bash
anchor heyo image publish \
  --name acme/agent:v1 \
  --rootfs ./rootfs.ext4 \
  --public
```

This wraps:

```text
heyctl artifact push ./rootfs.ext4 --tag acme/agent:v1 --public
```

The result is provider configuration:

```json
{
  "image": "acme/agent:v1",
  "imageKind": "artifact"
}
```

### Publish a Dockerfile manifest

```bash
anchor heyo image publish \
  --name acme/agent-dockerfile:v1 \
  --dockerfile ./Dockerfile \
  --context .
```

This wraps `heyctl artifact push-dockerfile` and returns
`imageKind: "dockerfile"`.

### Use it

```ts
const provider = heyo({
  token: process.env.HEYO_TOKEN!,
  server: process.env.HEYO_SERVER!,
  namespace: process.env.HEYO_NAMESPACE!,
  image: "acme/agent:v1",
  imageKind: "artifact", // or "dockerfile"
  imageStore: process.env.HEYO_IMAGE_STORE,
  sizeClass: "small",
  diskSizeGb: 10,
});
```

When the configured `imageKind` is `"artifact"`, a sandbox can also override
the artifact per run:

```ts
const sandbox = provider.create({ image: "acme/agent:v2" });
```

Dockerfile and git image kinds are provider-level; `spec.image` is rejected for
them. `HEYO_IMAGE_STORE` is copied into the returned provider config when set.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `anchor: command not found` | Package not installed, or the local build has no `dist/cli.js`. Install/build it or invoke the bin path directly. |
| `docker ... not found on PATH` | Install Docker or set `ANCHOR_DOCKER_BIN`/`DOCKER_BIN`. |
| `docker push` denied | Registry login, repository permissions, or network. |
| E2B module not found | Install the optional `e2b` package. |
| E2B rejects `--context` | E2B templates do not take a separate build context. |
| E2B rejects `--no-push` | `Template.build()` always publishes a template. |
| `heyctl` not found | Install it, set `HEYCTL_BIN`, or use Heyo's provider-level Dockerfile/git build instead. |
| Heyo push denied | `heyctl` login, namespace permissions, or store availability. |
| Heyo rejects `spec.image` | The provider is using `imageKind: "dockerfile"` or `"git"`; only artifact images accept a per-sandbox override. |

## Verification status

- The publisher contract and command construction are covered by unit tests
  with injected runners.
- Process-stream and provider-capability conformance is separate and does not
  publish real images.
- Real Docker/E2B/Heyo publishing is credential- and network-gated and is not
  part of the default CI suite.
- Docker was unavailable in the development session used to write this page;
  E2B and Heyo were not live-tested here.

## Related source

- `src/sandbox/image.ts` — common `ImagePublisher` contract
- `src/sandbox/docker/image.ts`
- `src/sandbox/e2b/image.ts`
- `src/sandbox/heyo/image.ts`
- `src/cli.ts` — `anchor image publish`
- `src/sandbox/README.md` — sandbox contract and provider guide
