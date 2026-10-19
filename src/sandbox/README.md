# The sandbox layer

Everything the agent does to a machine — clone, exec, checkpoint, push, notes —
goes through one contract: **`SandboxProvider`** (`provider.ts`). Products pick
a provider and never depend on a class. This directory is the package's whole
machine side.

```
subpath (package.json)    implementation              what it is
──────────────────────    ────────────────────────    ──────────────────────────────
sandbox/heyo              heyo/ (index, exec,        Heyo Cloud microVMs (remote)
                          secret)
sandbox/docker            docker/index.ts             containers on the local daemon
sandbox/local             local/index.ts              the host, NO isolation — dev/CI
```

E2B and Daytona are **planned** — stub modules exist in-repo (`e2b/`,
`daytona/`) so the shape is visible, but they are not exported subpaths and
their factories throw until they pass the conformance suite.

Two ways to open one (`index.ts`):

- **`openSandbox({ provider, spec, adopt?, fallbackSpec?, onRetainedGone?, onRefUnusable? })`**
  — explicit callbacks, for consumers that keep their own bookkeeping.
- **`openSandboxSession({ provider, store, key, sources, onRefUnusable? })`**
  — store-backed continuity: adopt the retained handle, clear the store when it
  is gone, try `sources` newest-usable-first, write back whatever opened.
  `SandboxStore` is `get`/`set`/`clear` on opaque keys; the package ships
  `MemorySandboxStore`, consumers bring the database (Sailor keys it by thread).

A handle (`{ id, backend }`) is stored verbatim — `backend` is the provider's
`name`, never inferred. One provider is chosen per run at a single point in the
product, and a handle owned by a different provider is skipped, not "gone".

## The contract (`provider.ts`)

| member | promise |
|---|---|
| `name` | stored verbatim on handles and in consumer databases |
| `capabilities` | **declared = tested**: the conformance suite gates scenarios on it (`local` once declared `fork: false` while implementing `fork()` — the suite caught it) |
| `create(spec)` | constructs only — **no I/O**; `start()` does the I/O |
| `adopt(handle, spec?)` | the workspace comes from the retained disk; `start()` proves it still exists; a failure is *gone*, not *fatal* |
| `release(handle)` | destroy by handle alone — no spec, no start; already-gone is not an error |
| `probe()` | cheap health check — what a `doctor` command calls |
| `prepare({ gitToken }?)` | optional pre-run maintenance (refreshed credentials, warmed caches). Best-effort by contract: the **caller** decides whether a failure is fatal. Heyo uses it to refresh the build secret its host-side image builds read |

## What `start()` must guarantee

1. **Workspace ready** — cloned at `spec.ref` (a callback is fine), copied from
   `spec.localPath`, or started from an image; `workspace` points at the repo.
2. **Git identity configured** — `spec.gitIdentity` (name/email).
3. **Credentials installed** — `spec.git.token` is a *callback*, not a string
   (installation tokens expire mid-run); call it per operation, for clone and
   for push.
4. **Reserved scratch** — run `reservedScratchPrepCommand()` (`git.ts`): creates
   `.anchor/` and git-excludes it. That directory is the agent's durable
   memory (`.anchor/notes.md` rides checkpoints; normal diffs never see it).
5. **`scratch`** — a lifecycle-scoped directory outside the repo for spills.

`retain: true` changes the destroy semantics: the workspace stays on disk so a
later `adopt` finds it (bounded by the consumer's janitor policy).

## Shared infra you get for free

**`git.ts`** — implement one small pair, inherit the whole git-facing surface:

```ts
git(args): Promise<string>            // throws on non-zero
shell(command): Promise<ExecResult>   // raw, for compound commands
```

Then use `checkpointVia(access, message, { push? })` (stage → commit →
optional push; a push failure is *reported on the checkpoint*, never thrown),
`hasChangesFromVia(access, ref)` (staged-tree compare; mode-insensitive), and
`reservedScratchPrepCommand()`. Don't hand-roll staging per backend.

**Exec contract** — `ExecResult` carries `exitCode`, `stdout`, `stderr`,
`output`, `timedOut`, `durationMs`, and on transport trouble
`failure: { kind: "transport", completion: "unknown", jobId, message }`.
The rules: honor `timeoutSecs` (kill the *process group*, map timeout exit
codes to `timedOut`), keep cwd/env fidelity, and **never replay a launch whose
result is unknown** — observe it first; an ambiguous mutation is worse than a
reported one. Case study: Heyo's control plane caps any single request at ~30s,
so `heyo/exec.ts` launches a detached supervised job inside the guest (FIFOs →
files, `timeout -k`, atomic exit receipt) and *observes* it with short polling
requests — copy that pattern for any backend with request ceilings or lossy
responses.

**The conformance suite** — `runSandboxConformance(provider)` from
`@anchor/core/testing` is the acceptance test for an adapter: exec fidelity,
self-containment, kill deadlines, env secrets, checkpoints, retain/adopt, git
identity, push-failure reporting, clone, `hasChangesFrom`, `localPath` copies,
bare-origin pushes, and `fork` where declared. Scenarios assert through
`Sandbox`/`SandboxProvider` only — never backend internals. A backend is "done"
when this passes (live backends opt in: `RUN_LIVE_HEYO_TESTS=1`,
`ANCHOR_DOCKER_TEST_IMAGE` like the Docker image).

## Adding a provider — checklist

1. Implement `Sandbox` + `SandboxProvider`; declare `capabilities` honestly
   (they gate conformance scenarios — promises, not vibes).
2. Implement `gitAccess()` and reuse `git.ts` for checkpoints/diffs.
3. Honor the spec: `repoUrl`/`ref`, `localPath` (only if `capabilities.localPath`
   — host directories, used by tests and copies), `retain`, `gitIdentity`,
   `git.token` (callback), `env` secrets.
4. Exec: timeouts, kill deadlines, env/cwd, the unknown-completion rule above.
5. Checkpoints: `checkpoint(message, { push? })`; push failures reported, not
   thrown; `destroy()` idempotent; `adopt` fails as "gone" not "crash".
6. Run `runSandboxConformance(provider)` until green; add a live, opt-in test.
7. Export on a subpath (`./sandbox/<name>`), SDK behind it — the root entry
   must stay SDK-free, and `tests/unit/genericity.test.ts` enforces it
   (including "no product nouns" in package source).

E2B and Daytona are planned: the stub modules stay in-repo as signposts but
are not exported; their factories throw with a pointer here until they pass
the conformance suite.

## Layout

```
index.ts     openSandbox / openSandboxSession / releaseSandbox + stores
provider.ts  the SandboxProvider contract (no implementations)
types.ts     Sandbox, SandboxSpec, ExecResult, handles
git.ts       shared git behavior (checkpoints, diffs, reserved scratch)
heyo/        Heyo Cloud: index (provider), exec (job transport), secret (admin)
docker/      Docker daemon containers
local/       the host itself — dev/CI only, no isolation
e2b/  daytona/   stubs
```
