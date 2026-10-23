/**
 * Sandbox conformance — the executable contract every provider must pass.
 *
 * Scenarios live here once and run against any `SandboxProvider`: exec
 * fidelity, self-containment, kill deadlines, env secrets, persistent process
 * streams, checkpoints, destruction, retention/adoption — plus clone, fork,
 * and host-path scenarios where the provider honestly declares the capability. A provider that passes
 * this file may call itself an adapter; one that fails has a bug, and one that
 * silently skips a capability it declares has a missing feature.
 *
 *   import { runSandboxConformance } from "anchor-ai-sdk/testing";
 *   runSandboxConformance(local({ rootDir, quiet: true }));
 *   runSandboxConformance(heyo(cfg), { timeoutMs: 240_000 });
 *
 * Vitest is an optional peer dependency — this entry is the only one that
 * loads it — and is called inside a test file exactly like a `describe`.
 * Scenario bodies stay framework-free in spirit: they assert through the
 * public `Sandbox`/`SandboxProvider` surface only, never through a backend's
 * own internals, so the suite can't drift toward one implementation.
 */
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SandboxProvider } from "./sandbox/provider.js";
import type { SandboxSpec } from "./sandbox/types.js";

/** Per-test timeout. Local backends answer in ms; microVMs boot — give them minutes. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** A fixture repository the clone-shaped scenarios can check out. */
export interface ConformanceRepo {
  /** URL the sandbox clones — a host path only for `localPath` providers. */
  repoUrl: string;
  /** Branch to check out after cloning. Default: the clone's default branch. */
  ref?: string;
  /** Expected `cat README.md` content after checkout (optional). */
  expectContains?: string;
}

export interface ConformanceOptions {
  /** Per-test timeout. Default 60s; microVM providers want 180–300s. */
  timeoutMs?: number;
  /**
   * A cloneable fixture for the remote scenarios. When omitted, those
   * scenarios run only for providers with host-path access
   * (`capabilities.localPath`), where the suite builds its own host fixture.
   */
  repo?: ConformanceRepo;
  /** Scenario names to skip loudly (exact match). */
  skip?: string[];
}

interface ConformanceContext {
  provider: SandboxProvider;
  options: ConformanceOptions;
  /** A unique host scratch directory inside the suite's tmp root. */
  tmp(name: string): Promise<string>;
  /** The repo fixture for the clone-shaped scenarios (may build a host one). */
  repoFixture(flavor: "clone" | "changes"): Promise<ConformanceRepo>;
}

interface Scenario {
  name: string;
  /** Static reason to skip — a capability the provider honestly lacks, or a missing fixture. */
  skip?: (ctx: ConformanceContext) => string | undefined;
  run: (ctx: ConformanceContext) => Promise<void>;
}

/** Run a git command on the HOST and fail loudly if it fails (fixtures only). */
function hostGit(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** Exists-as-a-directory probe that never throws. */
async function exists(p: string): Promise<boolean> {
  return realpath(p).then(
    () => true,
    () => false,
  );
}

/** Drain a ProcessHandle stream to a UTF-8 string. */
async function readProcessStream(
  stream: AsyncIterable<Uint8Array>,
): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += Buffer.from(chunk).toString("utf8");
  return text;
}

/** A host repo with `main` (v1) and a `feature` branch (v1+feature). */
async function buildCloneFixture(
  ctx: ConformanceContext,
): Promise<ConformanceRepo> {
  const dir = path.join(await ctx.tmp("origin-src"), "repo");
  await mkdir(dir, { recursive: true });
  hostGit(dir, "init", "-q", "-b", "main");
  hostGit(dir, "config", "user.name", "fixture");
  hostGit(dir, "config", "user.email", "fixture@localhost");
  await writeFile(path.join(dir, "README.md"), "v1\n");
  hostGit(dir, "add", "-A");
  hostGit(dir, "commit", "-qm", "v1");
  hostGit(dir, "checkout", "-qb", "feature");
  await writeFile(path.join(dir, "README.md"), "v1+feature\n");
  hostGit(dir, "commit", "-qam", "feature work");
  hostGit(dir, "checkout", "-q", "main");
  return { repoUrl: dir, ref: "feature", expectContains: "v1+feature" };
}

/** A host repo with one commit on `main` — the hasChangesFrom baseline. */
async function buildChangesFixture(
  ctx: ConformanceContext,
): Promise<ConformanceRepo> {
  const dir = path.join(await ctx.tmp("origin-changes-src"), "repo");
  await mkdir(dir, { recursive: true });
  hostGit(dir, "init", "-q", "-b", "main");
  hostGit(dir, "config", "user.name", "fixture");
  hostGit(dir, "config", "user.email", "fixture@localhost");
  await writeFile(path.join(dir, "README.md"), "v1\n");
  hostGit(dir, "add", "-A");
  hostGit(dir, "commit", "-qm", "v1");
  return { repoUrl: dir, ref: "main" };
}

const hasRepoAccess = (ctx: ConformanceContext): string | undefined =>
  ctx.options.repo || ctx.provider.capabilities.localPath
    ? undefined
    : "needs options.repo (this provider has no host-path access)";

const hasProcessStream = (ctx: ConformanceContext): string | undefined =>
  ctx.provider.capabilities.processStream
    ? undefined
    : "provider declares processStream: false";

const SCENARIOS: Scenario[] = [
  {
    name: "captures stdout, stderr, and exit codes faithfully",
    run: async ({ provider }) => {
      const sb = provider.create({});
      await sb.start();
      try {
        const r = await sb.exec(`echo out && echo err >&2 && exit 7`);
        expect(r.stdout).toContain("out");
        expect(r.stderr).toContain("err");
        expect(r.output).toContain("out");
        expect(r.output).toContain("err");
        expect(r.exitCode).toBe(7);
        expect(r.timedOut).toBe(false);
        expect(r.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "commands are self-contained — no state leaks between execs",
    run: async ({ provider }) => {
      const sb = provider.create({});
      await sb.start();
      try {
        await sb.exec(`export LEAK=1 && cd /tmp`);
        const r = await sb.exec(`echo "leak=\${LEAK:-none}" && pwd`);
        expect(r.stdout).toContain("leak=none");
        // Default cwd is the workspace. Resolve through realpath when the host
        // can see the path (macOS /tmp is a symlink); string-match otherwise.
        const pwd = r.stdout.trim().split("\n").pop()!;
        const resolved = await realpath(pwd).catch(() => pwd);
        const expected = await realpath(sb.workspace).catch(() => sb.workspace);
        expect([pwd, resolved]).toContain(expected);
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "actually kills a hung command at its deadline",
    run: async ({ provider }) => {
      const sb = provider.create({});
      await sb.start();
      try {
        const started = Date.now();
        const r = await sb.exec(`sleep 30`, { timeoutSecs: 1 });
        const elapsed = Date.now() - started;
        expect(r.timedOut).toBe(true);
        expect([124, 137]).toContain(r.exitCode); // SIGTERM (124) or SIGKILL (137)
        expect(elapsed).toBeLessThan(15_000); // killed at the deadline, not waited out
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "passes secrets as env vars — per call, merged over spec env",
    run: async ({ provider }) => {
      const sb = provider.create({ env: { BASE_VAR: "base" } });
      await sb.start();
      try {
        const r = await sb.exec(`echo "$BASE_VAR/$EXTRA_VAR"`, {
          env: { EXTRA_VAR: "extra" },
        });
        expect(r.stdout.trim()).toBe("base/extra");
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "declares an image publisher when it claims publishImage",
    skip: (ctx) =>
      ctx.provider.capabilities.publishImage
        ? undefined
        : "provider does not publish images",
    run: async ({ provider }) => {
      expect(provider.imagePublisher).toBeDefined();
      expect(provider.imagePublisher?.provider).toBe(provider.name);
      expect(provider.imagePublisher!.sources.length).toBeGreaterThan(0);
    },
  },

  {
    name: "declares previewPort only when exposePort is implemented",
    skip: (ctx) =>
      ctx.provider.capabilities.previewPort
        ? undefined
        : "provider declares previewPort: false",
    run: async ({ provider }) => {
      const sb = provider.create({});
      await sb.start();
      try {
        expect(typeof sb.exposePort).toBe("function");
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "process streams: stdin reaches stdout and exit status is reported",
    skip: hasProcessStream,
    run: async ({ provider }) => {
      const sb = provider.create({});
      await sb.start();
      try {
        if (!sb.openProcess)
          throw new Error("processStream is declared but openProcess is missing");
        const proc = await sb.openProcess("cat", []);
        await proc.write("hello from stdin\n");
        await proc.endInput();
        const [stdout, exit] = await Promise.all([
          readProcessStream(proc.stdout),
          proc.wait(),
        ]);
        expect(stdout).toContain("hello from stdin");
        expect(exit.exitCode).toBe(0);
        expect(exit.timedOut).toBe(false);
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "process streams: kill terminates a process and wait resolves",
    skip: hasProcessStream,
    run: async ({ provider }) => {
      const sb = provider.create({});
      await sb.start();
      try {
        if (!sb.openProcess)
          throw new Error("processStream is declared but openProcess is missing");
        const proc = await sb.openProcess("sleep", ["30"]);
        expect(await proc.kill("SIGKILL")).toBe(true);
        const exit = await proc.wait();
        expect(exit.timedOut).toBe(false);
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "process streams: timeout kills the process and reports timedOut",
    skip: hasProcessStream,
    run: async ({ provider }) => {
      const sb = provider.create({});
      await sb.start();
      try {
        if (!sb.openProcess)
          throw new Error("processStream is declared but openProcess is missing");
        const started = Date.now();
        const proc = await sb.openProcess("sleep", ["30"], {
          timeoutSecs: 1,
        });
        const exit = await proc.wait();
        expect(exit.timedOut).toBe(true);
        expect(Date.now() - started).toBeLessThan(15_000);
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "process streams: destroy closes an open process",
    skip: hasProcessStream,
    run: async ({ provider }) => {
      const sb = provider.create({});
      await sb.start();
      try {
        if (!sb.openProcess)
          throw new Error("processStream is declared but openProcess is missing");
        const proc = await sb.openProcess("sleep", ["30"]);
        await sb.destroy();
        await proc.wait();
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "checkpoint creates a real commit and returns its sha",
    run: async ({ provider }) => {
      const sb = provider.create({});
      await sb.start();
      try {
        await sb.exec(`echo "hello" > work.txt`);
        const cp = await sb.checkpoint("after reproduce");
        expect(cp.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(cp.message).toBe("after reproduce");
        expect((await sb.exec(`git log -1 --format=%s`)).stdout.trim()).toBe(
          "after reproduce",
        );
        expect((await sb.exec(`git rev-parse HEAD`)).stdout.trim()).toBe(
          cp.sha,
        );
        // A checkpoint with no changes still yields a valid resume point.
        const cp2 = await sb.checkpoint("no-op checkpoint");
        expect(cp2.sha).not.toBe(cp.sha);
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "destroy is idempotent and blocks further exec",
    run: async ({ provider }) => {
      const sb = provider.create({});
      await sb.start();
      await sb.destroy();
      await sb.destroy(); // second call is a no-op, not an error
      await expect(sb.exec("echo hi")).rejects.toThrow();
    },
  },

  {
    name: "clones a repo (with ref checkout) from a git URL",
    skip: hasRepoAccess,
    run: async (ctx) => {
      const repo = await ctx.repoFixture("clone");
      const spec: SandboxSpec = {
        repoUrl: repo.repoUrl,
        ...(repo.ref ? { ref: repo.ref } : {}),
      };
      const sb = ctx.provider.create(spec);
      await sb.start();
      try {
        const head = await sb.exec(`git rev-parse HEAD`);
        expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
        if (repo.ref) {
          const branch = await sb.exec(`git branch --show-current`);
          expect(branch.stdout.trim()).toBe(repo.ref);
        }
        if (repo.expectContains) {
          const readme = await sb.exec(`cat README.md`);
          expect(readme.stdout).toContain(repo.expectContains);
        }
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "hasChangesFrom compares TREES — checkpoint-only changes are not new work",
    skip: hasRepoAccess,
    run: async (ctx) => {
      const repo = await ctx.repoFixture("changes");
      const spec: SandboxSpec = {
        repoUrl: repo.repoUrl,
        ...(repo.ref ? { ref: repo.ref } : {}),
      };
      const sb = ctx.provider.create(spec);
      await sb.start();
      try {
        const branch = (
          await sb.exec(`git branch --show-current`)
        ).stdout.trim();
        const base = branch || "HEAD"; // detached HEAD still supports the tree comparison
        expect(await sb.hasChangesFrom(`origin/${base}`)).toBe(false);

        // THE LOOP TRAP, sealed at the interface: a checkpoint adds a commit
        // but no content — it must NOT read as new work (2026-10-18).
        await sb.checkpoint("after verify");
        expect(await sb.hasChangesFrom(`origin/${base}`)).toBe(false);

        // Uncommitted working-tree changes count.
        await sb.exec(`echo "more" >> README.md`);
        expect(await sb.hasChangesFrom(`origin/${base}`)).toBe(true);

        if (ctx.provider.capabilities.localPath && branch) {
          // The ref is refreshed before comparing: someone else pushed (host-side).
          await sb.exec("git reset -q --hard HEAD");
          await writeFile(path.join(repo.repoUrl, "README.md"), "v2\n");
          hostGit(repo.repoUrl, "commit", "-qam", "v2");
          expect(await sb.hasChangesFrom(`origin/${branch}`)).toBe(true);
        }

        // A ref that can't be resolved fails open.
        expect(await sb.hasChangesFrom("origin/does-not-exist")).toBe(true);
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "copies a localPath repo without mutating the original",
    skip: (ctx) =>
      ctx.provider.capabilities.localPath
        ? undefined
        : "provider has no host-path access (capabilities.localPath)",
    run: async (ctx) => {
      const fixture = path.join(await ctx.tmp("local-path-fixture"), "repo");
      await mkdir(fixture, { recursive: true });
      await writeFile(path.join(fixture, "file.txt"), "original\n");

      const sb = ctx.provider.create({ localPath: fixture });
      await sb.start();
      try {
        await sb.exec(`echo "edited" >> file.txt`);
        await sb.checkpoint("edit");
        expect((await sb.exec(`cat file.txt`)).stdout).toContain("edited");
        // The original is untouched.
        expect(await readFile(path.join(fixture, "file.txt"), "utf8")).toBe(
          "original\n",
        );
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "retain preserves the workspace and adopt resumes it with edits intact",
    skip: (ctx) =>
      ctx.provider.capabilities.retain
        ? undefined
        : "provider declares retain: false",
    run: async ({ provider }) => {
      const first = provider.create({ retain: true });
      await first.start();
      await first.exec(`echo "in progress" > work.txt`);
      await first.checkpoint("mid-work");
      await first.destroy(); // retained — the sandbox itself stays

      const handle = { id: first.id, backend: provider.name };
      const resumed = provider.adopt(handle);
      await resumed.start();
      try {
        expect(resumed.id).toBe(first.id);
        expect((await resumed.exec(`cat work.txt`)).stdout.trim()).toBe(
          "in progress",
        );
        expect(
          (await resumed.exec(`git log -1 --format=%s`)).stdout.trim(),
        ).toBe("mid-work");
      } finally {
        await resumed.destroy();
        // release() of an already-torn-down sandbox is not an error.
        await provider.release(handle);
      }
    },
  },

  {
    name: "adopt fails loudly when the retained sandbox is gone",
    skip: (ctx) =>
      ctx.provider.capabilities.retain
        ? undefined
        : "provider declares retain: false",
    run: async ({ provider }) => {
      const ghost = provider.adopt({
        id: `sb-anchor-ghost-${Date.now().toString(16)}`,
        backend: provider.name,
      });
      await expect(ghost.start()).rejects.toThrow();
    },
  },

  {
    name: "checkpoint push makes the resume point durable off-machine",
    skip: (ctx) =>
      ctx.provider.capabilities.localPath
        ? undefined
        : "needs a host-side bare origin (capabilities.localPath)",
    run: async (ctx) => {
      // A seed repo whose origin is a bare repo the HOST can inspect.
      const dir = await ctx.tmp("bare-origin");
      const seed = path.join(dir, "seed");
      const origin = path.join(dir, "origin.git");
      await mkdir(seed, { recursive: true });
      hostGit(seed, "init", "-q", "-b", "main");
      hostGit(seed, "config", "user.name", "fixture");
      hostGit(seed, "config", "user.email", "fixture@localhost");
      await writeFile(path.join(seed, "README.md"), "v1\n");
      hostGit(seed, "add", "-A");
      hostGit(seed, "commit", "-qm", "v1");
      hostGit(dir, "init", "-q", "--bare", origin);
      hostGit(seed, "remote", "add", "origin", origin);

      const sb = ctx.provider.create({ localPath: seed });
      await sb.start();
      try {
        await sb.exec(`echo "durable work" > work.txt`);
        const cp = await sb.checkpoint("mid-work", {
          push: "anchor/issue-7-checkpoint",
        });
        expect(cp.pushedTo).toBe("anchor/issue-7-checkpoint");
        expect(cp.pushError).toBeUndefined();
        const refs = spawnSync(
          "git",
          [
            `--git-dir=${origin}`,
            "rev-parse",
            "refs/heads/anchor/issue-7-checkpoint",
          ],
          { encoding: "utf8" },
        );
        expect(refs.status).toBe(0);
        expect(refs.stdout.trim()).toBe(cp.sha);
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "checkpoint push failure is reported, never thrown",
    run: async ({ provider }) => {
      const sb = provider.create({}); // no origin remote to push to
      await sb.start();
      try {
        await sb.exec(`echo "work" > work.txt`);
        const cp = await sb.checkpoint("mid-work", {
          push: "anchor/issue-7-checkpoint",
        });
        expect(cp.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(cp.pushError).toBeTruthy();
        expect(cp.pushedTo).toBeUndefined();
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "uses the configured git identity for checkpoints",
    run: async ({ provider }) => {
      const sb = provider.create({
        gitIdentity: {
          name: "anchor-test[bot]",
          email: "12345+anchor-test[bot]@users.noreply.github.com",
        },
      });
      await sb.start();
      try {
        await sb.exec(`echo "work" > work.txt`);
        await sb.checkpoint("identity check");
        const log = await sb.exec(`git log -1 --format='%an <%ae>'`);
        expect(log.stdout.trim()).toBe(
          "anchor-test[bot] <12345+anchor-test[bot]@users.noreply.github.com>",
        );
      } finally {
        await sb.destroy();
      }
    },
  },

  {
    name: "forks a sandbox at a checkpoint — independent copies of that state",
    skip: (ctx) =>
      ctx.provider.capabilities.fork
        ? undefined
        : "provider declares fork: false",
    run: async ({ provider }) => {
      const sb = provider.create({});
      await sb.start();
      try {
        await sb.exec("echo v1 > f.txt");
        const cp = await sb.checkpoint("v1");

        await sb.exec("echo v2 > f.txt"); // the original moves on

        const forked = await sb.fork(cp.sha);
        try {
          expect((await forked.exec("cat f.txt")).stdout.trim()).toBe("v1");
          // The fork is independent: edits there don't touch the original.
          await forked.exec("echo forked > f.txt");
          expect((await sb.exec("cat f.txt")).stdout.trim()).toBe("v2");
        } finally {
          await forked.destroy();
        }
      } finally {
        await sb.destroy();
      }
    },
  },
];

/**
 * Register the conformance suite for one provider — call at the top level of
 * a vitest test file, exactly like `describe`. Host fixtures are built lazily
 * and the suite's scratch root is removed after the file completes.
 */
export function runSandboxConformance(
  provider: SandboxProvider,
  options: ConformanceOptions = {},
): void {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let tmpRoot: string | undefined;
  let cloneFixture: Promise<ConformanceRepo> | undefined;
  let changesFixture: Promise<ConformanceRepo> | undefined;

  const ctx: ConformanceContext = {
    provider,
    options,
    tmp: async (name) => {
      tmpRoot ??= await mkdtemp(
        path.join(os.tmpdir(), `anchor-conformance-${provider.name}-`),
      );
      const dir = path.join(tmpRoot, name);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    repoFixture: async (flavor) => {
      if (options.repo) return options.repo;
      return flavor === "clone"
        ? (cloneFixture ??= buildCloneFixture(ctx))
        : (changesFixture ??= buildChangesFixture(ctx));
    },
  };

  describe(`${provider.name} sandbox conformance`, () => {
    afterAll(async () => {
      if (tmpRoot && (await exists(tmpRoot))) {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

    for (const scenario of SCENARIOS) {
      const reason = options.skip?.includes(scenario.name)
        ? "skipped by name"
        : scenario.skip?.(ctx);
      const body = () => scenario.run(ctx);
      if (reason) it.skip(scenario.name, body, timeout);
      else it(scenario.name, body, timeout);
    }
  });
}
