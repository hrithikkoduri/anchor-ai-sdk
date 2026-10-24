/** Addressed agent mailbox. The consumer owns the durable implementation. */
import { randomUUID } from "node:crypto";

export type AgentMessageKind = "request" | "result" | "question" | "update" | "review";
export type AgentMessageStatus = "pending" | "delivered" | "answered";

export interface AgentMessage {
  id: string;
  threadId: string;
  teamTaskId?: string;
  fromAgent: string;
  toAgent: string;
  kind: AgentMessageKind;
  body: string;
  status: AgentMessageStatus;
  createdAt: string;
  deliveredAt?: string;
  leaseUntil?: string;
  answeredAt?: string;
}

export interface NewAgentMessage {
  id?: string;
  threadId: string;
  teamTaskId?: string;
  fromAgent: string;
  toAgent: string;
  kind: AgentMessageKind;
  body: string;
}

export interface AgentMessageFilter {
  threadId?: string;
  teamTaskId?: string;
  toAgent?: string;
  fromAgent?: string;
  status?: AgentMessageStatus | AgentMessageStatus[];
}

export interface AgentMailbox {
  send(input: NewAgentMessage): Promise<AgentMessage>;
  list(filter?: AgentMessageFilter): Promise<AgentMessage[]>;
  /** Atomically claim pending messages for one recipient. */
  claim(input: { toAgent: string; limit?: number; leaseMs?: number }): Promise<AgentMessage[]>;
  /** Mark delivered messages as answered/handled. */
  ack(ids: string[]): Promise<void>;
  release(ids: string[]): Promise<void>;
}

export class MemoryAgentMailbox implements AgentMailbox {
  private readonly rows = new Map<string, AgentMessage>();

  async send(input: NewAgentMessage): Promise<AgentMessage> {
    const body = input.body.trim();
    if (!body) throw new Error("agent message body must not be empty");
    const message: AgentMessage = {
      id: input.id ?? randomUUID(),
      threadId: input.threadId,
      ...(input.teamTaskId ? { teamTaskId: input.teamTaskId } : {}),
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      kind: input.kind,
      body,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.rows.set(message.id, message);
    return { ...message };
  }

  async list(filter: AgentMessageFilter = {}): Promise<AgentMessage[]> {
    const statuses = filter.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : undefined;
    return [...this.rows.values()]
      .filter(
        (message) =>
          (filter.threadId === undefined || message.threadId === filter.threadId) &&
          (filter.teamTaskId === undefined || message.teamTaskId === filter.teamTaskId) &&
          (filter.toAgent === undefined || message.toAgent === filter.toAgent) &&
          (filter.fromAgent === undefined || message.fromAgent === filter.fromAgent) &&
          (statuses === undefined || statuses.has(message.status)),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((message) => ({ ...message }));
  }

  async claim(input: {
    toAgent: string;
    limit?: number;
    leaseMs?: number;
  }): Promise<AgentMessage[]> {
    const limit = Math.max(1, Math.floor(input.limit ?? 10));
    const now = Date.now();
    const leaseMs = Math.max(1, Math.floor(input.leaseMs ?? 60_000));
    const claimed = [...this.rows.values()]
      .filter(
        (message) =>
          message.toAgent === input.toAgent &&
          (message.status === "pending" ||
            (message.status === "delivered" &&
              (!message.leaseUntil || Date.parse(message.leaseUntil) <= now))),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    for (const message of claimed) {
      message.status = "delivered";
      message.deliveredAt = new Date(now).toISOString();
      message.leaseUntil = new Date(now + leaseMs).toISOString();
    }
    return claimed.map((message) => ({ ...message }));
  }

  async ack(ids: string[]): Promise<void> {
    for (const id of ids) {
      const message = this.rows.get(id);
      if (!message) continue;
      message.status = "answered";
      message.answeredAt = new Date().toISOString();
      delete message.leaseUntil;
    }
  }

  async release(ids: string[]): Promise<void> {
    for (const id of ids) {
      const message = this.rows.get(id);
      if (!message) continue;
      message.status = "pending";
      delete message.deliveredAt;
      delete message.leaseUntil;
    }
  }
}
