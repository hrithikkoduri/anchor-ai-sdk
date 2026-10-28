# The sandbox layer

Everything the agent does to a machine (clone, exec, checkpoint, push, notes)
goes through one contract: **`SandboxProvider`** (`provider.ts`). Products pick
a provider and never depend on a class. This directory is the package's whole
machine side.

```
subpath (package.json)    implementation              what it is
──────────────────────    ────────────────────────    ──────────────────────────────
sandbox/heyo              heyo/ (index, exec,        Heyo Cloud microVMs (remote)
                          secret)
sandbox/docker            docker/index.ts             containers on the local daemon
sandbox/e2b               e2b/ (index, exec)          E2B cloud sandboxes (remote)
sandbox/local             local/index.ts              the host, NO isolation: dev/CI
```

Daytona is **planned**: its stub module exists in-repo (`daytona/`) so the
shape is visible, but it is not an exported subpath and its factory throws
until it passes the conformance suite.

E2B boots a **template**, not an arbitrary Docker image at create time. Pass
`template` to `e2b()` (or let `SandboxSpec.image` name one) and build it with
the tools the task needs: at minimum `bash`, `git`, and coreutils including
`timeout`. `SandboxSpec.workspacePath` maps to a pre-existing workspace inside
the template (the SWE-bench `/testbed` shape), exactly like the Docker backend.

Two ways to open one (`index.ts`):

- **`openSandbox({ provider, spec, adopt?, fallbackSpec?, onRetainedGone?, onRefUnusable? })`**:
  explicit callbacks, for consumers that keep their own bookkeeping.
- **`openSandboxSession({ provider, store, key, sources, onRefUnusable? })`**:
  store-backed continuity: adopt the retained handle, clear the store when it
  is gone, try `sources` newest-usable-first, write back whatever opened.
  `SandboxStore` is `get`/`set`/`clear` on opaque keys; the package ships
  `MemorySandboxStore`, consumers bring the database (Sailor keys it by thread).

A handle (`{ id, backend }`) is stored verbatim: `backend` is the provider's
`name`, never inferred. One provider is chosen per run at a single point in the
product, and a handle owned by a different provider is skipped, not "gone".

## The contract (`provider.ts`)

| member | promise |
|---|---|
| `name` | stored verbatim on handles and in consumer databases |
| `capabilities` | **declared = tested**: the conformance suite gates scenarios on it (`local` once declared `fork: false` while implementing `fork()`; the suite caught it). `egressControl: true` means `spec.egress: "none"` is enforced after `start()`; a provider without it rejects `"none"` instead of running with network. `processStream: true` means `openProcess()` is implemented; the conformance suite exercises stdin, kill, timeout, and destroy. |
| `create(spec)` | constructs only, with **no I/O**; `start()` does the I/O |
| `adopt(handle, spec?)` | the workspace comes from the retained disk; `start()` proves it still exists; a failure is *gone*, not *fatal* |
| `release(handle)` | destroy by handle alone; no spec, no start; already-gone is not an error |
| `suspend(handle)` | optional: park a retained sandbox (keep the disk, stop the compute). `destroy()` never parks a retained sandbox, because runs may share it; the consumer calls this when nobody is using it. Already-gone is not an error |
| `probe()` | cheap health check, used by a `doctor` command |
| `imagePublisher` | optional publish seam; declared by `capabilities.publishImage`. It is slow and credentialed, so it lives outside `start()` |
| `exposePort(port)` | optional preview endpoint; declared by `capabilities.previewPort`. It returns a URL to a guest port and does not add preview auth or iframe policy |
| `prepare({ gitToken }?)` | optional pre-run maintenance (refreshed credentials, warmed caches). Best-effort by contract: the **caller** decides whether a failure is fatal. Heyo uses it to refresh the build secret its host-side image builds read |

## What `start()` must guarantee

1. **Workspace ready**: cloned at `spec.ref` (a callback is fine), copied from
   `spec.localPath`, or started from an image; `workspace` points at the repo.
2. **Git identity configured**: `spec.gitIdentity` (name/email).
3. **Credentials installed**: `spec.git.token` is a *callback*, not a string
   (installation tokens expire mid-run); call it per operation, for clone and
   for push.
4. **Reserved scratch**: run `reservedScratchPrepCommand()` (`git.ts`): creates
   `.anchor/` and git-excludes it. That directory is the agent's durable
   memory (`.anchor/notes.md` rides checkpoints; normal diffs never see it).
5. **`scratch`**: a lifecycle-scoped directory outside the repo for spills.

`retain: true` changes the destroy semantics: the workspace stays on disk so a
later `adopt` finds it (bounded by the consumer's janitor policy). destroy()
detaches only this run — it must not stop or park a sandbox other runs may be
using; parking is `provider.suspend`, called by the consumer.

## Shared infra you get for free

**`git.ts`**: implement one small pair, inherit the whole git-facing surface:

```ts
git(args): Promise<string>            // throws on non-zero
shell(command): Promise<ExecResult>   // raw, for compound commands
```

Then use `checkpointVia(access, message, { push? })` (stage → commit →
optional push; a push failure is *reported on the checkpoint*, never thrown),
`hasChangesFromVia(access, ref)` (staged-tree compare; mode-insensitive), and
`reservedScratchPrepCommand()`. Don't hand-roll staging per backend.

**Exec contract**: `ExecResult` carries `exitCode`, `stdout`, `stderr`,
`output`, `timedOut`, `durationMs`, and on transport trouble
`failure: { kind: "transport", completion: "unknown", jobId, message }`.
The rules: honor `timeoutSecs` (kill the *process group*, map timeout exit
codes to `timedOut`), keep cwd/env fidelity, and **never replay a launch whose
result is unknown**: observe it first; an ambiguous mutation is worse than a
reported one. Case study: Heyo's control plane caps any single request at ~30s,
so `heyo/exec.ts` launches a detached supervised job inside the guest (FIFOs →
files, `timeout -k`, atomic exit receipt) and *observes* it with short polling
requests: copy that pattern for any backend with request ceilings or lossy
responses.

**Several jobs, not one slot.** A backend may run concurrent execs
(`ExecOptions.concurrent`, set only by read-only tools); mutations keep the
safety gate and wait for an unresolved earlier job instead of overlapping it.
A job past its guest-side deadline (the supervisor's `timeout -k` already
fired) is **killed and cleared**: the adapter `pkill`s the guest job and
removes its receipt directory before failing the call. A lost receipt fails
that one command; it must never wedge every later command in the sandbox.

**Background commands.** `ExecOptions.backgroundAfterSecs` asks the adapter to
*return control* while the command is still running; the result carries
`background: { jobId }` (not a failure). The caller reads it later with
`pollJob(jobId, { startedAt, timeoutSecs })` returns `undefined` while running,
the `ExecResult` once finished, and may `killJob(jobId)`. `timeoutSecs` stays the
job's hard lifetime, so it must exceed the detach threshold; a detached job no
longer blocks later mutations (it is intentionally still running). Because the
job lives in the guest, the sandbox must outlive the turn: the Heyo adapter
sets `spec.retain` on detach and `destroy()` **defers parking** while the
executor still has jobs.

The engine owns delivery when the provider can poll: it tracks the job ids and,
before every model call (and again before a finish), calls `pollJob` and
injects a finished result as a `runtime` message. `runtime` is persisted in the
thread (a resumed run still knows the job finished) but is not a nudge, so a
consumer may hide it in the UI. The body goes through the same truncate-and-
spill rule as a normal tool result.

`background: true` on a tool is the permission to detach; `execPolicy(ctx)`
decides whether it may (consumer opted in, sandbox can poll, command outlives
the threshold). `bash` sets it; other tools opt in the same way. Before a normal finish it waits for what is left,
bounded by the job's deadline; only a job that outlives that is reported on
`AgentResult.pendingJobs`, which the consumer can hand back as `resumeJobs` on
the next run. The model never polls. Heyo's `poll`/`kill` also work from a
*fresh* adopted instance (no in-memory registry), which is what the wait uses.

**Preview ports.** Providers that can expose a guest HTTP port implement
`exposePort(port)` and declare `capabilities.previewPort: true`. E2B returns
`https://<sandbox-host>` for the port; E2B URLs are public by default. Local,
Docker, Heyo, and Daytona declare `previewPort: false`; no provider is allowed
to fake a preview. Anchor does not add authentication, health checks, or UI.

**Persistent process streams.** `exec()` is one-shot. For LSPs, REPLs, dev
servers, watchers, and interactive CLIs, `Sandbox.openProcess(command, args,
opts)` starts a process that stays alive: `write()`/`endInput()` feed stdin,
`stdout`/`stderr` are async iterables, `wait()` reports the exit, and
`kill()`/`timeoutSecs`/`AbortSignal` terminate it. The command and args are
separate, so no user text is shell-interpolated. `capabilities.processStream`
gates the feature; a provider that cannot support it must omit `openProcess`
rather than fake it with repeated `exec` calls. Destroy closes every open
process, and each backend caps concurrency with a clear error.

Local, Docker, and E2B provide separate stderr. Heyo runs the process through
its interactive PTY: stderr is merged into stdout, `endInput()` has Ctrl-D
semantics, and the WebSocket has no drain signal. Use Local/Docker/E2B when a
consumer needs strict stderr or real stdin backpressure. No LSP or JSON-RPC
types belong in core; [`anchor-ai-sdk/lsp`](../../docs/lsp.md) layers that
protocol on this primitive.

**The conformance suite**: `runSandboxConformance(provider)` from
`anchor-ai-sdk/testing` is the acceptance test for an adapter: exec fidelity,
self-containment, kill deadlines, env secrets, process streams (stdin, kill,
timeout, destroy), preview-port declaration, declared image-publisher presence, checkpoints, retain/adopt, git identity, push-failure
reporting, clone, `hasChangesFrom`, `localPath` copies, bare-origin pushes, and
`fork` where declared. Scenarios assert through `Sandbox`/`SandboxProvider`
only, never backend internals. A backend is "done" when this passes (live
backends opt in: `RUN_LIVE_HEYO_TESTS=1`, `ANCHOR_DOCKER_TEST_IMAGE` like the
Docker image).

## Images and boot cost

`start()` pays for the image, and that price is **not** free; budget for it.
The Heyo adapter resolves the rootfs from `imageKind`:

| `imageKind` | at `start()` | cost |
|---|---|---|
| `artifact` (**preferred**) | host **pulls** a prebuilt rootfs from `imageStore` | fast, no build |
| `dockerfile` | host **builds** the rootfs from a manifest | slow cold start |
| `git` | host **clones the repo and builds its Dockerfile** | slow, plus a clone; set `imageContext` when the Dockerfile is not at the repo root |

A first host-side build can take longer than a boot: `readyTimeoutMs`
(default 15 minutes) bounds the readiness wait, and a failed build job throws
with the builder's log instead of reading as a generic boot timeout.

Prefer `artifact`. The build kinds pay clone-and-build on a cold start, and the
`git` kind reads a build secret while building; that is what
`prepare({ gitToken })` exists for (it refreshes that secret so a build never
clones with a stale token). The reference deployment runs `artifact`
(`harness/sailor-toolchain:latest`): its boot measured 125.6s against 207s for
the git build. Point `imageStore` at the store that holds the tag; it defaults
to the public hub, not a namespace's own store.

**Boot dominates short runs.** Measured 2026-10-19 on the reference setup: a
13-step run took 260s wall-clock; **207s inside `start()`** (pull/build, ready
wait, clone, credentials) and 53s of actual agent work. Anything that compares
"run duration" across backends must separate boot from work, or a fast adapter
reads as a slow agent.

The conformance suite deliberately asserts `start()`'s **guarantees** (workspace,
git identity, credentials, scratch), not how long they take; measure boot per
backend yourself. `create()` stays I/O-free precisely so the boot is
retryable/adoptable, and the boot itself lives in `start()`.

## Custom images

Publishing is an explicit, optional `imagePublisher` seam, not a registry push
inside `start()`. Heyo can still build a configured Dockerfile/git source during
startup. `SandboxSpec.image` is a per-sandbox override only where
the provider can vary its image. The consumer-facing guide is
[docs/sandbox-image-publishing.md](../../docs/sandbox-image-publishing.md).

| Provider | Default image | Per-sandbox `spec.image` | How a custom image gets there |
|---|---|---|---|
| **Docker** | `docker({ image })` | **Yes**; wins over the default | `anchor image publish --provider docker ...` builds and pushes with the Docker CLI. `start()` pulls the name if it is not already local. |
| **E2B** | `e2b({ template })` | **Yes**, but it is an E2B **template name or ID**, not a Docker image | `anchor image publish --provider e2b ...` builds/publishes a template with E2B's `Template.build()`; repo scripts also exist. Passing a Docker image fails with guidance. |
| **Heyo** | `heyo({ image, imageKind, imageStore })` | **Artifact only**; dockerfile/git builds are provider-level and reject it | `anchor image publish --provider heyo ...` wraps `heyctl artifact push`. `imageKind: "artifact"` pulls a prebuilt rootfs from `imageStore` (default `https://hub.heyo.work`); `"dockerfile"` / `"git"` make the Heyo host build it. |
| **Local** | none | **No**; rejected loudly | Host filesystem only; use `spec.localPath` or Docker. |
| **Daytona** | planned | not available | Stub only; factory throws until it passes conformance. |

If a task needs a prebaked repository, use `spec.workspacePath` on Docker, E2B,
or Heyo so `start()` verifies the checkout instead of cloning.

### Publishing through the common contract

Providers that can publish set `capabilities.publishImage` and expose an
`imagePublisher`. The publisher is a slow deployment seam, separate from
`start()`:

```ts
const published = await provider.imagePublisher!.publish({
  name: "acme/agent:v1",
  source: { kind: "dockerfile", path: "Dockerfile", context: "." },
});

// Docker/E2B: use the ref per sandbox.
const sandbox = provider.create({ image: published.ref });

// Heyo: merge its provider-level image config, then optionally pass
// `image: published.ref` per sandbox when imageKind is "artifact".
```

`ImagePublisher.sources` declares which of `dockerfile`, `image`, and `rootfs`
the provider accepts. Unsupported sources fail loudly. Results say whether the
ref belongs in `SandboxSpec.image` or in provider configuration.

The CLI uses the same contract and loads only the selected provider:

```bash
# Docker: build and push a container image
anchor image publish --provider docker --name ghcr.io/acme/agent:v1 \
  --dockerfile Dockerfile --context .

# E2B: build and publish a template
anchor e2b image publish --name acme-agent:v1 --from-image ubuntu:24.04

# Heyo: upload a rootfs to the namespace store
anchor heyo image publish --name acme/agent:v1 --rootfs ./rootfs.ext4 --public
```

Provider-first (`anchor e2b image publish`) and `--provider` forms are
equivalent. Docker uses the CLI login; E2B reads `E2B_API_KEY`; Heyo uses the
`heyctl` login (set `HEYCTL_BIN` if it is not on `PATH`; `HEYO_IMAGE_STORE`
is copied into the returned provider config). Local and the Daytona stub have
no image publisher. Nothing in Anchor logs build arguments; treat
provider build output as potentially sensitive.

A uniform **build-and-push implementation** now exists through this seam, but
it is still provider-native: Docker pushes to a container registry, E2B builds
a template, and Heyo uploads an artifact. There is no cross-provider registry
of Anchor images.

### Publishing troubleshooting

- **`anchor: command not found`** — the package is not installed (or the local
  build has not produced `dist/cli.js`). Install it, run `npm run build`, or
  invoke the package's bin path explicitly.
- **`docker ... not found on PATH`** — install Docker or set
  `ANCHOR_DOCKER_BIN`/`DOCKER_BIN`. A failed `docker push` is usually registry
  auth or network, not an Anchor command error.
- **E2B module missing** — install the optional `e2b` peer dependency.
  `--context` is rejected because E2B's `fromDockerfile` has no separate build
  context.
- **Heyo publishing fails** — `heyctl` must be installed, logged in, and able to
  reach the namespace store; it is not bundled with Anchor. Its install builds
  are currently Linux x86_64. `HEYO_IMAGE_STORE` is copied into the returned
  config when set.
- **Heyo Dockerfile/git images** — per-sandbox `spec.image` is accepted only for
  `imageKind: "artifact"`; use the returned provider config for the other
  kinds.

These are integration prerequisites rather than sandbox-contract failures. The
unit suite exercises the contract with injected runners; real registry pushes
are credential- and network-gated and are not part of CI.

## Adding a provider: checklist

> **Boot cost is part of the contract.** Prefer `artifact` images and measure
> `start()`; see *Images and boot cost*.



1. Implement `Sandbox` + `SandboxProvider`; declare `capabilities` honestly
   (they gate conformance scenarios: promises, not vibes).
2. Implement `gitAccess()` and reuse `git.ts` for checkpoints/diffs.
3. Honor the spec: `repoUrl`/`ref`, `localPath` (only if `capabilities.localPath`
, host directories, used by tests and copies), `retain`, `gitIdentity`,
   `git.token` (callback), `env` secrets.
4. Exec: timeouts, kill deadlines, env/cwd, the unknown-completion rule above;
   concurrent read-only calls opt in with `ExecOptions.concurrent`, and an
   expired job is killed and cleared (a lost receipt fails one command, never
   the sandbox).
5. Checkpoints: `checkpoint(message, { push? })`; push failures reported, not
   thrown; `destroy()` idempotent; `adopt` fails as "gone" not "crash".
6. If declaring `capabilities.processStream`, implement `openProcess()` with
   stdin/stdout/stderr, `wait`, `kill`, deadline/abort, a concurrency cap, and
   destroy cleanup; the conformance suite gates the scenarios on the flag.
7. Run `runSandboxConformance(provider)` until green; add a live, opt-in test.
8. Export on a subpath (`./sandbox/<name>`), SDK behind it; the root entry
   must stay SDK-free, and `tests/unit/genericity.test.ts` enforces it
   (including "no product nouns" in package source).

Daytona is planned: its stub module stays in-repo as a signpost but is not
exported; its factory throws with a pointer here until it passes the
conformance suite.

### E2B notes

- **Templates, not images.** E2B has no Docker-image-at-create; `spec.image`
  is a template name. Build the template with `Template().fromImage(...)` or
  `fromDockerfile(...)`, then pass its name.
- **Retain ≠ pause.** `destroy()` of a retained sandbox detaches the run and
  leaves the VM running: several runs may share one sandbox, and pausing it
  when one of them ends froze it under the others (adopts then failed their
  workspace check mid-pause). The consumer pauses it with
  `provider.suspend(handle)` once nobody is using it; a retained sandbox is
  created with `lifecycle.onTimeout: "pause"`, so an idle one still pauses
  (memory and disk survive) without anyone calling `suspend`. `adopt()`
  connects/resumes it. `keep` leaves it running for debugging.
- **Adopt is gone only when E2B says so.** `connect` answering "not found" is
  `SandboxGoneError`. A workspace check that fails is retried (connect +
  check, with backoff — a resume may still be settling), then thrown as
  `WorkspaceUnavailableError`, which `isGone` never accepts: the disk is still
  on record and must not be re-cloned over. `provider.release(handle)` is the FINAL teardown and
  kills even a retained sandbox: it does not know the run's `retain` flag, so
  a sweep must not call it on a thread it means to resume.
- **Fork = native snapshot.** `fork()` snapshots the VM, attaches the fork,
  then resets it to the requested commit (`checkout -f` + `clean -fd`) so the
  result matches the contract's clean-checkpoint semantics.
- **Timeout.** The adapter wraps every command in guest-side `timeout -k`, so
  E2B's control-plane `timeoutMs` is not trusted as a process kill.
- **Credentials.** `git.token` is resolved into `GIT_TOKEN` and a repo-local
  credential helper; the token never enters the workspace. One mint is reused
  for five minutes, so a callback that hits GitHub does not run on every
  command.

## Layout

```
index.ts     openSandbox / openSandboxSession / releaseSandbox + stores
provider.ts  the SandboxProvider contract (no implementations)
types.ts     Sandbox, SandboxSpec, ExecResult, ProcessHandle, handles
process.ts   provider-neutral ChildProcess stream handle (local/docker)
image.ts     common image-publishing contract (ImagePublisher/ImageSource)
command.ts   host-command runner for image publishers
git.ts       shared git behavior (checkpoints, diffs, reserved scratch)
heyo/        Heyo Cloud: index (provider), exec (job transport), secret (admin)
docker/      Docker daemon containers
e2b/         E2B cloud sandboxes: index (provider), exec (command/result)
local/       the host itself: dev/CI only, no isolation
daytona/     stub: planned, not exported
```
