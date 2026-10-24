/** Durable team task board. The consumer owns the durable implementation. */
import { randomUUID } from "node:crypto";

export type TeamTaskStatus =
  | "queued"
  | "claimed"
  | "in_progress"
  | "blocked"
  | "done"
  | "failed";

export interface TeamTask {
  id: string;
  threadId: string;
  parentTaskId?: string;
  title: string;
  description?: string;
  status: TeamTaskStatus;
  ownerAgent?: string;
  role?: "worker" | "evaluator";
  repo?: string;
  path?: string;
  leaseUntil?: string;
  result?: string;
  evidenceIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NewTeamTask {
  id?: string;
  threadId: string;
  parentTaskId?: string;
  title: string;
  description?: string;
  role?: "worker" | "evaluator";
  repo?: string;
  path?: string;
}

export interface TeamTaskFilter {
  threadId?: string;
  parentTaskId?: string;
  status?: TeamTaskStatus | TeamTaskStatus[];
  ownerAgent?: string;
}

export interface ClaimTeamTaskInput {
  id: string;
  agent: string;
  /** Lease duration in milliseconds. */
  leaseMs: number;
}

export interface TeamTaskStore {
  create(input: NewTeamTask): Promise<TeamTask>;
  get(id: string): Promise<TeamTask | undefined>;
  list(filter?: TeamTaskFilter): Promise<TeamTask[]>;
  /** Atomic: succeeds only when queued or its previous lease expired. */
  claim(input: ClaimTeamTaskInput): Promise<TeamTask | undefined>;
  update(
    id: string,
    patch: Partial<
      Pick<
        TeamTask,
        "status" | "ownerAgent" | "leaseUntil" | "result" | "evidenceIds"
      >
    >,
  ): Promise<TeamTask | undefined>;
  /** Release a task back to queued, only for its current owner. */
  release(id: string, agent: string): Promise<boolean>;
}

function expired(leaseUntil: string | undefined, now: number): boolean {
  if (!leaseUntil) return true;
  const at = Date.parse(leaseUntil);
  return !Number.isFinite(at) || at <= now;
}

/** In-memory adapter for tests and single-process consumers. */
export class MemoryTeamTaskStore implements TeamTaskStore {
  private readonly rows = new Map<string, TeamTask>();

  async create(input: NewTeamTask): Promise<TeamTask> {
    const title = input.title.trim();
    if (!title) throw new Error("team task title must not be empty");
    const now = new Date().toISOString();
    const task: TeamTask = {
      id: input.id ?? randomUUID(),
      threadId: input.threadId,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      title,
      ...(input.description ? { description: input.description } : {}),
      status: "queued",
      ...(input.role ? { role: input.role } : {}),
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.path ? { path: input.path } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(task.id, task);
    return { ...task };
  }

  async get(id: string): Promise<TeamTask | undefined> {
    const task = this.rows.get(id);
    return task ? { ...task } : undefined;
  }

  async list(filter: TeamTaskFilter = {}): Promise<TeamTask[]> {
    const statuses = filter.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : undefined;
    return [...this.rows.values()]
      .filter(
        (task) =>
          (filter.threadId === undefined || task.threadId === filter.threadId) &&
          (filter.parentTaskId === undefined ||
            task.parentTaskId === filter.parentTaskId) &&
          (filter.ownerAgent === undefined ||
            task.ownerAgent === filter.ownerAgent) &&
          (statuses === undefined || statuses.has(task.status)),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((task) => ({ ...task }));
  }

  async claim(input: ClaimTeamTaskInput): Promise<TeamTask | undefined> {
    const task = this.rows.get(input.id);
    if (!task) return undefined;
    const reclaimable =
      task.status !== "done" &&
      task.status !== "failed" &&
      (task.status === "queued" || expired(task.leaseUntil, Date.now()));
    if (!reclaimable) return undefined;
    task.status = "claimed";
    task.ownerAgent = input.agent;
    task.leaseUntil = new Date(Date.now() + Math.max(1, input.leaseMs)).toISOString();
    task.updatedAt = new Date().toISOString();
    return { ...task };
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        TeamTask,
        "status" | "ownerAgent" | "leaseUntil" | "result" | "evidenceIds"
      >
    >,
  ): Promise<TeamTask | undefined> {
    const task = this.rows.get(id);
    if (!task) return undefined;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    return { ...task };
  }

  async release(id: string, agent: string): Promise<boolean> {
    const task = this.rows.get(id);
    if (!task || task.ownerAgent !== agent) return false;
    task.status = "queued";
    delete task.ownerAgent;
    delete task.leaseUntil;
    task.updatedAt = new Date().toISOString();
    return true;
  }
}
