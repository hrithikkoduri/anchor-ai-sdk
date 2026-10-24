import { describe, expect, it } from "vitest";
import {
  MemoryAgentMailbox,
  MemoryTeamTaskStore,
} from "../../src/teams/index.js";

describe("team task board", () => {
  it("creates queued child tasks and lists by parent", async () => {
    const store = new MemoryTeamTaskStore();
    const task = await store.create({
      threadId: "thread",
      parentTaskId: "root",
      title: "Implement retry",
      repo: "acme/api",
    });
    expect(task).toMatchObject({
      threadId: "thread",
      parentTaskId: "root",
      title: "Implement retry",
      status: "queued",
      repo: "acme/api",
    });
    await expect(store.list({ parentTaskId: "root" })).resolves.toHaveLength(1);
    await expect(store.list({ parentTaskId: "other" })).resolves.toHaveLength(0);
  });

  it("atomically claims a task and prevents a second owner", async () => {
    const store = new MemoryTeamTaskStore();
    const task = await store.create({ threadId: "t", title: "work" });
    const claims = await Promise.all([
      store.claim({ id: task.id, agent: "a", leaseMs: 60_000 }),
      store.claim({ id: task.id, agent: "b", leaseMs: 60_000 }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find(Boolean)!;
    expect(claimed.ownerAgent).toBe("a");
    expect(claimed.status).toBe("claimed");
  });

  it("reclaims an expired lease and releases only for the owner", async () => {
    const store = new MemoryTeamTaskStore();
    const task = await store.create({ threadId: "t", title: "work" });
    await store.claim({ id: task.id, agent: "a", leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reclaimed = await store.claim({
      id: task.id,
      agent: "b",
      leaseMs: 60_000,
    });
    expect(reclaimed?.ownerAgent).toBe("b");
    await expect(store.release(task.id, "a")).resolves.toBe(false);
    await expect(store.release(task.id, "b")).resolves.toBe(true);
    await expect(store.get(task.id)).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("records result and evidence on update", async () => {
    const store = new MemoryTeamTaskStore();
    const task = await store.create({ threadId: "t", title: "work" });
    await store.update(task.id, {
      status: "done",
      result: "implemented",
      evidenceIds: ["e1"],
    });
    await expect(store.get(task.id)).resolves.toMatchObject({
      status: "done",
      result: "implemented",
      evidenceIds: ["e1"],
    });
  });
});

describe("agent mailbox", () => {
  it("delivers only to the addressed recipient", async () => {
    const mail = new MemoryAgentMailbox();
    await mail.send({
      threadId: "t",
      fromAgent: "reviewer",
      toAgent: "implementer",
      kind: "review",
      body: "fix the timeout case",
    });
    await mail.send({
      threadId: "t",
      fromAgent: "reviewer",
      toAgent: "researcher",
      kind: "question",
      body: "check the docs",
    });
    const claimed = await mail.claim({ toAgent: "implementer" });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      fromAgent: "reviewer",
      kind: "review",
      status: "delivered",
    });
    await expect(mail.claim({ toAgent: "implementer" })).resolves.toHaveLength(0);
  });

  it("reclaims a delivered message after its lease expires", async () => {
    const mail = new MemoryAgentMailbox();
    const message = await mail.send({
      threadId: "t",
      fromAgent: "reviewer",
      toAgent: "implementer",
      kind: "review",
      body: "fix it",
    });
    await mail.claim({ toAgent: "implementer", leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      mail.claim({ toAgent: "implementer", leaseMs: 60_000 }),
    ).resolves.toMatchObject([{ id: message.id, status: "delivered" }]);
  });

  it("acks and releases claimed messages", async () => {
    const mail = new MemoryAgentMailbox();
    const message = await mail.send({
      threadId: "t",
      fromAgent: "implementer",
      toAgent: "reviewer",
      kind: "result",
      body: "done",
    });
    await mail.claim({ toAgent: "reviewer" });
    await mail.ack([message.id]);
    await expect(mail.list({ status: "answered" })).resolves.toHaveLength(1);

    const second = await mail.send({
      threadId: "t",
      fromAgent: "implementer",
      toAgent: "reviewer",
      kind: "update",
      body: "still working",
    });
    await mail.claim({ toAgent: "reviewer" });
    await mail.release([second.id]);
    await expect(mail.list({ status: "pending" })).resolves.toHaveLength(1);
  });

  it("rejects empty message bodies", async () => {
    const mail = new MemoryAgentMailbox();
    await expect(
      mail.send({
        threadId: "t",
        fromAgent: "a",
        toAgent: "b",
        kind: "request",
        body: " ",
      }),
    ).rejects.toThrow(/body/);
  });
});
