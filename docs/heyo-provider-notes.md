# Heyo provider notes

Snapshot: 2026-10-23, Anchor `0.2.0`.

Use this page when the question is about Heyo capabilities, especially app
previews and the E2B comparison.

## Current capabilities

| Capability | Heyo |
| --- | --- |
| `retain` / adopt | Yes |
| Remote checkpoint / git push | Yes |
| `processStream` | Yes, but backed by a PTY |
| Detached jobs (`pollJob`, `killJob`) | Yes |
| `publishImage` | Yes, artifact-only for per-sandbox images |
| Native `fork()` | No |
| Preview ports (`previewPort`) | **No** |
| Raw pipe-backed stdout/stderr | No; stderr is merged into the PTY stream |

## Preview ports: the important gap

E2B implements `Sandbox.exposePort(port)` and declares
`capabilities.previewPort: true`, returning a public HTTPS URL for an app running
inside the sandbox.

Heyo currently:

- declares `previewPort: false`
- hardcodes `routes: []`
- has no public guest-port route

So the app can run inside the Heyo VM, but the host/user cannot open a supported
live preview URL through Anchor today.

A real preview feature needs more than the port:

- start the app and wait for health
- expose the guest port
- route/proxy it publicly
- authentication and access policy
- iframe/embedding policy
- idle stop and cleanup
- logs and error display
- the preview UI

Anchor intentionally supplies only the endpoint. The consumer owns the product
surface and access policy.

## Workarounds today

- Use **E2B** for in-sandbox live app previews.
- Use **Local** or **Docker** when the host can map/proxy the port.
- Run a tunnel or reverse proxy inside the Heyo guest (for example
  `cloudflared` or `ngrok`) and hand the resulting URL to the consumer. This is
  consumer-owned infrastructure; Anchor does not currently manage it.
- Build static assets in the sandbox and serve them from the host outside the
  sandbox.

## What implementing Heyo previews would require

- Extend `HeyoSandboxConfig` with explicit route/port configuration.
- Implement `HeyoSandbox.exposePort(port)` and set
  `capabilities.previewPort: true`.
- Add health/readiness semantics or leave them to the consumer.
- Verify live routing, auth, and cleanup against a real Heyo deployment.
- Add conformance coverage for the new capability.

## Related files

- `src/sandbox/heyo/index.ts` — provider capabilities and sandbox lifecycle.
- `src/sandbox/types.ts` — `Sandbox.exposePort` / `PreviewEndpoint` contract.
- `docs/sandbox-image-publishing.md` — artifact versus Dockerfile/git images.
- `src/sandbox/README.md` — preview-port and process-stream contracts.
- `ROADMAP.md` — deferred Heyo ports/routes item.

## Other Heyo differences from E2B

- **No native `fork()`**; retained-sandbox wake/adopt is the substitute.
- **PTY process streams**: separate stderr and raw backpressure are not
  available, so byte-sensitive LSP/JSON-RPC is not live-verified on Heyo.
- **Artifact image model**: per-sandbox `spec.image` only works with
  `imageKind: "artifact"`; Dockerfile/git builds are provider-level.
- Heyo uniquely exposes detached job polling/killing, which E2B does not.
