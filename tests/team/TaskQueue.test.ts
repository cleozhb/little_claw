import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Database } from "../../src/db/Database.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import type { RegisteredAgent } from "../../src/team/AgentRegistry.ts";

const TEST_DB = "/tmp/little_claw_task_queue_test.db";

let db: Database;
let queue: TaskQueue;

beforeEach(() => {
  db = new Database(TEST_DB);
  queue = new TaskQueue(db);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

function agent(name: string, tags: string[], maxConcurrentTasks = 2): RegisteredAgent {
  return {
    config: {
      name,
      display_name: name,
      role: "Test agent",
      status: "active",
      aliases: [],
      direct_message: true,
      tools: [],
      skills: [],
      task_tags: tags,
      cron_jobs: [],
      requires_approval: [],
      max_concurrent_tasks: maxConcurrentTasks,
      max_tokens_per_task: 50000,
      timeout_minutes: 30,
    },
    soul: "",
    operatingInstructions: "",
    currentTasks: [],
    status: "idle",
  };
}

describe("TaskQueue", () => {
  test("creates a task and writes a created log", () => {
    const task = queue.createTask({
      title: "Translate episode",
      description: "Translate the latest podcast.",
      createdBy: "human",
      priority: 5,
      tags: ["podcast", "translation"],
      project: "podcast-translation",
      channelId: "channel-1",
      sourceMessageId: "message-1",
      dueAt: "2026-05-01T00:00:00.000Z",
    });

    expect(task.id).toBeTruthy();
    expect(task.status).toBe("pending");
    expect(task.priority).toBe(5);
    expect(task.tags).toEqual(["podcast", "translation"]);
    expect(queue.getTask(task.id)?.project).toBe("podcast-translation");

    const logs = queue.getTaskLogs(task.id);
    expect(logs.map((log) => log.eventType)).toEqual(["created"]);
    expect(logs[0]?.agentName).toBe("human");
  });

  test("runs pending to assigned to running to completed", () => {
    const task = queue.createTask({
      title: "Fix bug",
      description: "Fix the failing test.",
      createdBy: "human",
      tags: ["code"],
    });

    const assigned = queue.assignTask(task.id, "coder");
    expect(assigned.status).toBe("assigned");
    expect(assigned.assignedTo).toBe("coder");

    const running = queue.startTask(task.id);
    expect(running.status).toBe("running");
    expect(running.startedAt).toBeTruthy();

    const completed = queue.completeTask(task.id, "All tests pass.");
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("All tests pass.");
    expect(completed.completedAt).toBeTruthy();

    expect(queue.getTaskLogs(task.id).map((log) => log.eventType)).toEqual([
      "created",
      "assigned",
      "started",
      "completed",
    ]);
  });

  test("does not assign tasks until dependencies are completed", () => {
    const parent = queue.createTask({
      title: "Parent",
      description: "Finish first.",
      createdBy: "human",
    });
    const child = queue.createTask({
      title: "Child",
      description: "Depends on parent.",
      createdBy: "human",
      dependsOn: [parent.id],
    });

    expect(() => queue.assignTask(child.id, "coder")).toThrow("incomplete dependencies");

    queue.assignTask(parent.id, "coder");
    queue.startTask(parent.id);
    queue.completeTask(parent.id, "done");

    expect(queue.assignTask(child.id, "coder").status).toBe("assigned");
  });

  test("stores approval prompt, data, approve response, and resume state", () => {
    const task = queue.createTask({
      title: "Publish",
      description: "Needs human approval.",
      createdBy: "human",
      assignedTo: "writer",
    });

    queue.startTask(task.id);
    const awaiting = queue.requestApproval(task.id, {
      prompt: "Publish this translation?",
      data: { url: "https://example.test/post" },
      agentName: "writer",
    });
    expect(awaiting.status).toBe("awaiting_approval");
    expect(awaiting.approvalPrompt).toBe("Publish this translation?");
    expect(awaiting.approvalData).toEqual({ url: "https://example.test/post" });

    const approved = queue.approveTask(task.id, "Approved by CEO.", "human");
    expect(approved.status).toBe("approved");
    expect(approved.approvalResponse).toBe("Approved by CEO.");

    const resumed = queue.startTask(task.id);
    expect(resumed.status).toBe("running");
  });

  test("rejects approval into a distinct rejected state", () => {
    const task = queue.createTask({
      title: "Select show",
      description: "Needs approval.",
      createdBy: "human",
      assignedTo: "podcast-translator",
    });

    queue.startTask(task.id);
    queue.requestApproval(task.id, { prompt: "Translate this show?" });
    const rejected = queue.rejectTask(task.id, "Pick a different show.", "human");

    expect(rejected.status).toBe("rejected");
    expect(rejected.approvalResponse).toBe("Pick a different show.");
    expect(queue.startTask(task.id).status).toBe("running");
  });

  test("failTask retries while under max retries and then fails permanently", () => {
    const task = queue.createTask({
      title: "Flaky task",
      description: "May fail.",
      createdBy: "human",
      assignedTo: "coder",
      maxRetries: 2,
    });

    queue.startTask(task.id);
    const retry = queue.failTask(task.id, "first failure");
    expect(retry.status).toBe("pending");
    expect(retry.retryCount).toBe(1);
    expect(retry.assignedTo).toBeUndefined();

    queue.assignTask(task.id, "coder");
    queue.startTask(task.id);
    const failed = queue.failTask(task.id, "second failure");
    expect(failed.status).toBe("failed");
    expect(failed.retryCount).toBe(2);
    expect(failed.error).toBe("second failure");

    expect(queue.getTaskLogs(task.id).map((log) => log.eventType)).toEqual([
      "created",
      "assigned",
      "started",
      "failed",
      "retry_scheduled",
      "assigned",
      "started",
      "failed",
    ]);
  });

  test("listTasks filters by status, assignment, project, tags, and limit", () => {
    queue.createTask({
      title: "Code task",
      description: "Implement.",
      createdBy: "human",
      assignedTo: "coder",
      tags: ["code"],
      project: "app",
    });
    queue.createTask({
      title: "Research task",
      description: "Investigate.",
      createdBy: "human",
      tags: ["research"],
      project: "docs",
    });

    expect(queue.listTasks({ assignedTo: "coder" })).toHaveLength(1);
    expect(queue.listTasks({ project: "docs" })[0]?.title).toBe("Research task");
    expect(queue.listTasks({ tags: ["code"] })[0]?.title).toBe("Code task");
    expect(queue.listTasks({ status: "pending", limit: 1 })).toHaveLength(1);
  });

  test("getPendingForAgent respects tags, dependencies, priority, and concurrency", () => {
    const completedDependency = queue.createTask({
      title: "Dependency",
      description: "Complete me.",
      createdBy: "human",
    });
    queue.assignTask(completedDependency.id, "coder");
    queue.startTask(completedDependency.id);
    queue.completeTask(completedDependency.id, "done");

    const blockedDependency = queue.createTask({
      title: "Blocked dependency",
      description: "Still pending.",
      createdBy: "human",
    });
    const lowPriority = queue.createTask({
      title: "Low priority",
      description: "Can code later.",
      createdBy: "human",
      tags: ["code"],
      priority: 1,
    });
    const highPriority = queue.createTask({
      title: "High priority",
      description: "Code now.",
      createdBy: "human",
      tags: ["code"],
      priority: 10,
      dependsOn: [completedDependency.id],
    });
    queue.createTask({
      title: "Blocked",
      description: "Not ready.",
      createdBy: "human",
      tags: ["code"],
      priority: 99,
      dependsOn: [blockedDependency.id],
    });
    queue.createTask({
      title: "Research",
      description: "Wrong tag.",
      createdBy: "human",
      tags: ["research"],
      priority: 20,
    });

    const candidates = queue.getPendingForAgent(agent("coder", ["code"], 2));
    expect(candidates.map((task) => task.id)).toEqual([highPriority.id, lowPriority.id]);

    queue.assignTask(highPriority.id, "coder");
    queue.startTask(highPriority.id);

    expect(queue.getPendingForAgent(agent("coder", ["code"], 1))).toEqual([]);
  });

  test("delegateTask creates a child task and records progress logs", () => {
    const parent = queue.createTask({
      title: "Parent",
      description: "Delegate work.",
      createdBy: "human",
      assignedTo: "coordinator",
    });

    const child = queue.delegateTask(parent.id, {
      title: "Child",
      description: "Do delegated work.",
      assignedTo: "coder",
      tags: ["code"],
    });
    queue.addProgress(child.id, "Started investigation.", "coder");

    expect(child.createdBy).toBe("coordinator");
    expect(queue.getTask(parent.id)?.blocks).toEqual([child.id]);
    expect(queue.getTaskLogs(parent.id).map((log) => log.eventType)).toContain("delegated");
    expect(queue.getTaskLogs(child.id).map((log) => log.eventType)).toContain("progress");
  });
});
