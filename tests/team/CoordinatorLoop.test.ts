import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import type { ChatOptions, LLMProvider } from "../../src/llm/types.ts";
import { AgentRegistry } from "../../src/team/AgentRegistry.ts";
import { CoordinatorLoop } from "../../src/team/CoordinatorLoop.ts";
import { ProjectChannelStore } from "../../src/team/ProjectChannelStore.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import { TeamMessageStore } from "../../src/team/TeamMessageStore.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";

const TEST_DB = "/tmp/little_claw_coordinator_loop_test.db";

let db: Database;
let tasks: TaskQueue;
let messages: TeamMessageStore;
let channels: ProjectChannelStore;
let agents: AgentRegistry;
let toolRegistry: ToolRegistry;
let agentDir: string;

beforeEach(() => {
  db = new Database(TEST_DB);
  tasks = new TaskQueue(db);
  messages = new TeamMessageStore(db);
  channels = new ProjectChannelStore(db, messages);
  toolRegistry = new ToolRegistry();
  agentDir = mkdtempSync(join(tmpdir(), "little-claw-coordinator-loop-agents-"));
  agents = new AgentRegistry(agentDir);
  createCoordinator();
  createCoder();
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

describe("CoordinatorLoop", () => {
  test("assigns pending tasks to tag-matched agents without calling LLM", async () => {
    const task = tasks.createTask({
      title: "Fix bug",
      description: "Use deterministic tag assignment.",
      createdBy: "human",
      tags: ["code"],
      priority: 10,
    });
    const llm = new ScriptedLLM([]);
    const loop = coordinatorLoop(llm);

    await loop.tick();

    expect(tasks.getTask(task.id)?.status).toBe("assigned");
    expect(tasks.getTask(task.id)?.assignedTo).toBe("coder");
    expect(llm.calls).toHaveLength(0);
  });

  test("timed out tasks fail and are escalated to coordinator channel", async () => {
    const task = tasks.createTask({
      title: "Long running task",
      description: "Should time out.",
      createdBy: "human",
      assignedTo: "coder",
      maxRetries: 1,
    });
    tasks.startTask(task.id, "coder");
    setTaskStartedAt(task.id, new Date(Date.now() - 2 * 60_000).toISOString());
    const loop = coordinatorLoop(new ScriptedLLM([{ type: "text", text: "ack timeout" }]));

    await loop.tick();

    expect(tasks.getTask(task.id)?.status).toBe("failed");
    const escalation = messages.listMessages({
      channelType: "coordinator",
      channelId: "default",
      taskId: task.id,
    })[0];
    expect(escalation?.content).toContain("failed and needs coordinator attention");
    expect(escalation?.status).toBe("injected");
  });

  test("summarizes busy project channels and marks source messages resolved", async () => {
    channels.createChannel({ slug: "lovely-octopus", title: "Lovely Octopus" });
    const first = channels.postMessage("lovely-octopus", {
      senderType: "human",
      senderId: "ceo",
      content: "We need a coordinator loop.",
    });
    const second = channels.postMessage("lovely-octopus", {
      senderType: "agent",
      senderId: "coder",
      content: "I can implement the TypeScript modules.",
    });
    const llm = new ScriptedLLM([
      { type: "text", text: "Summary: implement CoordinatorLoop and tests." },
    ]);
    const loop = coordinatorLoop(llm, { projectSummaryThreshold: 2 });

    await loop.tick();

    expect(messages.getMessage(first.id)?.status).toBe("resolved");
    expect(messages.getMessage(second.id)?.status).toBe("resolved");
    expect(
      channels.listMessages("lovely-octopus").some((message) =>
        message.content.includes("Summary: implement CoordinatorLoop"),
      ),
    ).toBe(true);
    expect(llm.calls[0]?.tools).toEqual([]);
  });

  test("processes coordinator inbox through AgentLoop with CoordinatorTools", async () => {
    const inbound = messages.createMessage({
      channelType: "coordinator",
      channelId: "default",
      senderType: "human",
      senderId: "ceo",
      content: "Please triage this ambiguous team request.",
    });
    const llm = new ScriptedLLM([{ type: "text", text: "I will coordinate this." }]);
    const loop = coordinatorLoop(llm);

    await loop.tick();

    expect(messages.getMessage(inbound.id)?.status).toBe("injected");
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.system).toContain("<agent_soul>");
    expect(llm.calls[0]?.system).toContain("Coordinator soul from registry.");
    expect(llm.calls[0]?.tools.map((tool) => tool.name)).toContain("create_task");
    expect(
      messages.listMessages({
        channelType: "coordinator",
        channelId: "default",
        senderId: "coordinator",
      })[0]?.content,
    ).toBe("I will coordinate this.");
  });

  test("routes coordinator replies for project task escalations back to the project channel", async () => {
    const channel = channels.createChannel({ slug: "research-project", title: "Research Project" });
    const task = tasks.createTask({
      title: "Research long-running agents",
      description: "This failed while coder was working.",
      createdBy: "coordinator",
      assignedTo: "coder",
      project: channel.slug,
      channelId: channel.id,
      maxRetries: 1,
    });
    tasks.startTask(task.id, "coder");
    tasks.failTask(task.id, "429 TPM limit", "coder");
    const llm = new ScriptedLLM([{ type: "text", text: "团队状态汇报：研究任务失败，需要错峰重试。" }]);
    const loop = coordinatorLoop(llm);

    await loop.tick();

    expect(messages.listMessages({ channelType: "coordinator", channelId: "default" })[0]?.status).toBe(
      "injected",
    );
    expect(
      channels
        .listMessages(channel.slug)
        .some((message) =>
          message.senderId === "coordinator" && message.content.includes("团队状态汇报"),
        ),
    ).toBe(true);
  });

  test("processes project channel messages when the project has no open task", async () => {
    const channel = channels.createChannel({ slug: "lovely-octopus", title: "Lovely Octopus" });
    const inbound = channels.postMessage(channel.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "请创建一个任务来调查 pending 状态卡住的问题。",
    });
    const llm = new ScriptedLLM([
      {
        type: "tool",
        name: "create_task",
        input: {
          title: "调查 pending 状态卡住",
          description: "复现项目频道任务失败后 pending 且后续消息无响应的问题。",
          tags: ["code"],
          project: channel.slug,
          channel_id: channel.id,
          source_message_id: inbound.id,
        },
      },
      { type: "text", text: "已创建调查任务。" },
    ]);
    const loop = coordinatorLoop(llm);

    await loop.tick();

    const createdTask = tasks.listTasks({ project: channel.slug })[0];
    expect(createdTask?.status).toBe("pending");
    expect(createdTask?.sourceMessageId).toBe(inbound.id);
    expect(messages.getMessage(inbound.id)?.status).toBe("injected");
    expect(JSON.stringify(llm.calls[0]?.messages ?? [])).toContain(inbound.content);
    expect(
      channels
        .listMessages(channel.slug)
        .some((message) => message.senderId === "coordinator" && message.content === "已创建调查任务。"),
    ).toBe(true);
  });

  test("leaves project channel messages pending when an open project task can consume them", async () => {
    const channel = channels.createChannel({ slug: "lovely-octopus", title: "Lovely Octopus" });
    const task = tasks.createTask({
      title: "Existing project task",
      description: "Worker should consume project updates.",
      createdBy: "coordinator",
      project: channel.slug,
      tags: ["code"],
    });
    const inbound = channels.postMessage(channel.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "补充：这个信息应该给 worker。",
    });
    const llm = new ScriptedLLM([]);
    const loop = coordinatorLoop(llm);

    await loop.tick();

    expect(tasks.getTask(task.id)?.status).toBe("assigned");
    expect(messages.getMessage(inbound.id)?.status).toBe("new");
    expect(llm.calls).toHaveLength(0);
  });

  test("handles project channel messages when existing pending tasks are unassigned", async () => {
    const channel = channels.createChannel({ slug: "research-project", title: "Research Project" });
    const task = tasks.createTask({
      title: "Research long-running agents",
      description: "No active agent currently matches this research-only task.",
      createdBy: "coordinator",
      project: channel.slug,
      tags: ["research", "long-running-tasks"],
    });
    const inbound = channels.postMessage(channel.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "刚刚那个任务做到哪儿了？",
    });
    const llm = new ScriptedLLM([{ type: "text", text: "当前任务还在 pending，尚未分配给执行 agent。" }]);
    const loop = coordinatorLoop(llm);

    await loop.tick();

    expect(tasks.getTask(task.id)?.status).toBe("pending");
    expect(tasks.getTask(task.id)?.assignedTo).toBeUndefined();
    expect(messages.getMessage(inbound.id)?.status).toBe("injected");
    expect(
      channels
        .listMessages(channel.slug)
        .some((message) => message.senderId === "coordinator" && message.content.includes("还在 pending")),
    ).toBe(true);
  });

  test("rejected tasks do not block project channel message processing", async () => {
    const channel = channels.createChannel({ slug: "lovely-octopus", title: "Lovely Octopus" });
    const task = tasks.createTask({
      title: "Task awaiting approval",
      description: "Human rejected this step.",
      createdBy: "coordinator",
      project: channel.slug,
      assignedTo: "coder",
    });
    tasks.startTask(task.id, "coder");
    tasks.requestApproval(task.id, { prompt: "May I proceed?", agentName: "coder" });
    tasks.rejectTask(task.id, "No, try a different approach.", "ceo");
    expect(tasks.getTask(task.id)?.status).toBe("rejected");

    const inbound = channels.postMessage(channel.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "换一种方案来做吧。",
    });
    const llm = new ScriptedLLM([{ type: "text", text: "好的，我来调整方案。" }]);
    const loop = coordinatorLoop(llm);

    await loop.tick();

    // rejected 任务不应阻塞项目频道，coordinator 应能处理新消息
    expect(messages.getMessage(inbound.id)?.status).toBe("injected");
    expect(llm.calls).toHaveLength(1);
  });

  test("end-to-end: coordinator message creates a task via tool call, then next tick assigns it to coder", async () => {
    channels.createChannel({ slug: "lovely-octopus", title: "Lovely Octopus" });
    const inbound = messages.createMessage({
      channelType: "coordinator",
      channelId: "default",
      project: "lovely-octopus",
      senderType: "human",
      senderId: "ceo",
      content: "Break this into an implementation task for the engineering agent.",
    });
    const llm = new ScriptedLLM([
      {
        type: "tool",
        name: "create_task",
        input: {
          title: "Implement Lovely Octopus coordinator",
          description: "Add CoordinatorTools, CoordinatorLoop, and tests.",
          tags: ["code"],
          project: "lovely-octopus",
        },
      },
      { type: "text", text: "Created the implementation task." },
    ]);
    const loop = coordinatorLoop(llm);

    await loop.tick();
    const createdTask = tasks.listTasks({ project: "lovely-octopus" })[0];
    expect(createdTask?.status).toBe("pending");
    expect(messages.getMessage(inbound.id)?.status).toBe("injected");

    await loop.tick();

    const assignedTask = tasks.getTask(createdTask!.id);
    expect(assignedTask?.status).toBe("assigned");
    expect(assignedTask?.assignedTo).toBe("coder");
    expect(llm.calls[0]?.tools.map((tool) => tool.name)).toContain("create_task");
    expect(llm.calls[1]?.messages.some((message) => JSON.stringify(message).includes(createdTask!.id))).toBe(
      true,
    );
  });
});

function coordinatorLoop(
  llmProvider: LLMProvider,
  options: Partial<ConstructorParameters<typeof CoordinatorLoop>[0]> = {},
): CoordinatorLoop {
  return new CoordinatorLoop({
    agents,
    tasks,
    messages,
    channels,
    llmProvider,
    toolRegistry,
    maxTurns: 4,
    ...options,
  });
}

function createCoordinator() {
  return agents.create("coordinator", {
    config: {
      name: "coordinator",
      role: "Coordinate team work.",
      tools: [],
      task_tags: ["coordination", "planning", "summary"],
      timeout_minutes: 1,
    },
    soul: "# Soul\nCoordinator soul from registry.\n",
    operatingInstructions: "# Agent Operating Instructions\nCoordinate through durable facts.\n",
  });
}

function createCoder() {
  return agents.create("coder", {
    config: {
      name: "coder",
      role: "Implement code tasks.",
      aliases: ["dev"],
      tools: [],
      task_tags: ["code", "test"],
      timeout_minutes: 1,
    },
    soul: "# Soul\nCoder soul.\n",
    operatingInstructions: "# Agent Operating Instructions\nImplement carefully.\n",
  });
}

function setTaskStartedAt(taskId: string, startedAt: string): void {
  (db as any).db.run(`UPDATE tasks SET started_at = ?1 WHERE id = ?2`, startedAt, taskId);
}

type ScriptedReply =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: Record<string, unknown> };

class ScriptedLLM implements LLMProvider {
  calls: Array<{
    messages: Message[];
    system: string;
    tools: NonNullable<ChatOptions["tools"]>;
  }> = [];

  constructor(private replies: ScriptedReply[]) {}

  async *chat(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls.push({
      messages: [...messages],
      system: options?.system ?? "",
      tools: options?.tools ?? [],
    });
    const reply = this.replies.shift() ?? { type: "text", text: "" };
    if (reply.type === "text") {
      yield { type: "text_delta", text: reply.text };
      yield {
        type: "message_end",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      return;
    }

    yield { type: "tool_use_start", id: `tool-${this.calls.length}`, name: reply.name };
    yield { type: "tool_use_delta", input_json: JSON.stringify(reply.input) };
    yield { type: "tool_use_end" };
    yield {
      type: "message_end",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }

  getModel(): string {
    return "scripted-coordinator-test-model";
  }

  setModel(_model: string): void {}
}
