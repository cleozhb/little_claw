import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import { AgentRegistry } from "../../src/team/AgentRegistry.ts";
import { ProjectChannelStore } from "../../src/team/ProjectChannelStore.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import { TeamMessageStore } from "../../src/team/TeamMessageStore.ts";
import { TeamRouter } from "../../src/team/TeamRouter.ts";

const TEST_DB = "/tmp/little_claw_team_router_test.db";

let db: Database;
let messages: TeamMessageStore;
let channels: ProjectChannelStore;
let tasks: TaskQueue;
let registry: AgentRegistry;
let router: TeamRouter;
let agentDir: string;

beforeEach(() => {
  db = new Database(TEST_DB);
  messages = new TeamMessageStore(db);
  channels = new ProjectChannelStore(db, messages);
  tasks = new TaskQueue(db);
  agentDir = mkdtempSync(join(tmpdir(), "little-claw-router-agents-"));
  registry = new AgentRegistry(agentDir);
  registry.create("coder", {
    config: {
      name: "coder",
      role: "Writes code",
      aliases: ["dev"],
      direct_message: true,
      task_tags: ["code"],
      tools: ["shell"],
    },
  });
  router = new TeamRouter({
    agentRegistry: registry,
    taskQueue: tasks,
    messages,
    projectChannels: channels,
  });
});

afterEach(() => {
  db.close();
  rmSync(agentDir, { recursive: true, force: true });
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

function route(text: string, externalMessageId: string = crypto.randomUUID()) {
  return router.routeHumanMessage({
    externalChannel: "feishu",
    externalChatId: "chat-1",
    externalMessageId,
    userId: "ceo",
    text,
  });
}

describe("TeamRouter", () => {
  test("routes @agent alias messages to the agent DM channel", () => {
    const result = route("@dev 修复这个 bug");
    const message = messages.getMessage(result.messageId);

    expect(result.routedTo).toEqual({ type: "agent", id: "coder" });
    expect(result.ack).toContain("@coder");
    expect(result.asyncWorkStarted).toBe(false);
    expect(message?.channelType).toBe("agent_dm");
    expect(message?.channelId).toBe("coder");
    expect(message?.status).toBe("routed");
  });

  test("routes #project messages to a project channel and creates it if needed", () => {
    const result = route("#lovely-octopus 加一个 AGENTS.md");
    const channel = channels.getChannel("lovely-octopus");
    const message = messages.getMessage(result.messageId);

    expect(channel).toBeTruthy();
    expect(result.routedTo).toEqual({ type: "project", id: "lovely-octopus" });
    expect(message?.channelType).toBe("project");
    expect(message?.channelId).toBe(channel?.id);
    expect(message?.project).toBe("lovely-octopus");
  });

  test("/project binds the current external chat and plain messages default to that project", () => {
    const bind = route("/project lovely-octopus", "bind-1");
    const plain = route("继续补测试", "plain-1");

    expect(bind.routedTo).toEqual({ type: "project", id: "lovely-octopus" });
    expect(channels.resolveExternalChat("feishu", "chat-1")?.channelType).toBe("project");
    expect(plain.routedTo).toEqual({ type: "project", id: "lovely-octopus" });
    expect(messages.getMessage(plain.messageId)?.project).toBe("lovely-octopus");
  });

  test("/task approve and reject commands update awaiting approval tasks directly", () => {
    const approveTask = tasks.createTask({
      title: "Publish",
      description: "Needs approval.",
      createdBy: "human",
      assignedTo: "coder",
    });
    tasks.startTask(approveTask.id);
    tasks.requestApproval(approveTask.id, { prompt: "Publish?" });

    const approved = route(`/task ${approveTask.id} approve 可以发`, "approve-1");
    expect(approved.routedTo).toEqual({ type: "task", id: approveTask.id });
    expect(tasks.getTask(approveTask.id)?.status).toBe("approved");
    expect(tasks.getTask(approveTask.id)?.approvalResponse).toBe("可以发");
    expect(messages.getMessage(approved.messageId)?.status).toBe("resolved");

    const rejectTask = tasks.createTask({
      title: "Pick show",
      description: "Needs approval.",
      createdBy: "human",
      assignedTo: "coder",
    });
    tasks.startTask(rejectTask.id);
    tasks.requestApproval(rejectTask.id, { prompt: "Pick this show?" });

    const rejected = route(`/task ${rejectTask.id} reject 换一个`, "reject-1");
    expect(rejected.routedTo).toEqual({ type: "task", id: rejectTask.id });
    expect(tasks.getTask(rejectTask.id)?.status).toBe("rejected");
    expect(tasks.getTask(rejectTask.id)?.approvalResponse).toBe("换一个");
  });

  test("unrecognized messages route to coordinator with a human ack", () => {
    const result = route("这个入口不知道该给谁");
    const message = messages.getMessage(result.messageId);

    expect(result.routedTo).toEqual({ type: "coordinator", id: "default" });
    expect(result.ack.length).toBeGreaterThan(0);
    expect(message?.channelType).toBe("coordinator");
    expect(message?.channelId).toBe("default");
  });

  test("deduplicates external retries without applying task commands twice", () => {
    const task = tasks.createTask({
      title: "Publish",
      description: "Needs approval.",
      createdBy: "human",
      assignedTo: "coder",
    });
    tasks.startTask(task.id);
    tasks.requestApproval(task.id, { prompt: "Publish?" });

    const first = route(`/task ${task.id} approve ok`, "retry-message");
    const retry = route(`/task ${task.id} approve ok`, "retry-message");

    expect(first.messageId).toBe(retry.messageId);
    expect(retry.ack).toContain("重复消息");
    expect(tasks.getTask(task.id)?.status).toBe("approved");
  });
});
