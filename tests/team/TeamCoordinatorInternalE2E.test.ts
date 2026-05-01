import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import type { ChatOptions, LLMProvider } from "../../src/llm/types.ts";
import { AgentRegistry } from "../../src/team/AgentRegistry.ts";
import { AgentWorker, REPORT_PROGRESS_TOOL, REQUEST_APPROVAL_TOOL } from "../../src/team/AgentWorker.ts";
import { CoordinatorLoop } from "../../src/team/CoordinatorLoop.ts";
import { ProjectChannelStore } from "../../src/team/ProjectChannelStore.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import { TeamMessageStore } from "../../src/team/TeamMessageStore.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";

const TEST_DB = "/tmp/little_claw_team_coordinator_internal_e2e_test.db";

let db: Database;
let messages: TeamMessageStore;
let channels: ProjectChannelStore;
let tasks: TaskQueue;
let agents: AgentRegistry;
let toolRegistry: ToolRegistry;
let agentDir: string;

beforeEach(() => {
  db = new Database(TEST_DB);
  messages = new TeamMessageStore(db);
  channels = new ProjectChannelStore(db, messages);
  tasks = new TaskQueue(db);
  toolRegistry = new ToolRegistry();
  toolRegistry.register(fakeTool("read_file"));
  agentDir = mkdtempSync(join(tmpdir(), "little-claw-team-coordinator-e2e-agents-"));
  agents = new AgentRegistry(agentDir);

  agents.create("coordinator", {
    config: {
      name: "coordinator",
      role: "Coordinate team work.",
      aliases: ["coord"],
      tools: [],
      task_tags: ["coordination", "planning", "summary"],
      max_concurrent_tasks: 1,
    },
    soul: "# Soul\nCoordinator keeps durable coordination records.\n",
    operatingInstructions: "# Operating\nCreate tasks through CoordinatorTools and let workers execute them.\n",
  });
  agents.create("coder", {
    config: {
      name: "coder",
      role: "Implement code tasks.",
      aliases: ["dev"],
      tools: ["read_file"],
      task_tags: ["code", "test"],
      max_concurrent_tasks: 1,
    },
    soul: "# Soul\nCoder executes assigned implementation tasks.\n",
    operatingInstructions: "# Operating\nUse task context and report progress before finishing.\n",
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

describe("Team mode internal E2E", () => {
  test("coordinator inbox creates a task, assigns it to coder, and AgentWorker completes it", async () => {
    const project = channels.createChannel({
      slug: "lovely-octopus",
      title: "Lovely Octopus",
    });
    const coordinatorRequest = messages.createMessage({
      channelType: "coordinator",
      channelId: "default",
      project: project.slug,
      senderType: "human",
      senderId: "ceo",
      content: "请拆解并安排实现 Lovely Octopus Coordinator 内部 E2E。",
      priority: "high",
    });
    const projectContext = channels.postMessage(project.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "项目补充：任务要覆盖 CoordinatorLoop 到 AgentWorker 的内部链路。",
    });
    const llm = new ScriptedLLM([
      {
        type: "tool",
        name: "create_task",
        input: {
          title: "实现 Coordinator 内部 E2E",
          description: "验证 CoordinatorLoop 创建任务、分配给 coder，并由 AgentWorker 完成。",
          tags: ["code", "test"],
          project: project.slug,
          channel_id: project.id,
          source_message_id: coordinatorRequest.id,
        },
      },
      { type: "text", text: "已创建内部 E2E 实现任务。" },
      {
        type: "tool",
        name: REPORT_PROGRESS_TOOL,
        input: {
          task_id: "__TASK_ID__",
          content: "已读取 Coordinator 创建的任务和项目上下文。",
        },
      },
      { type: "text", text: "内部 E2E 已完成。" },
    ]);
    const coordinator = new CoordinatorLoop({
      agents,
      tasks,
      messages,
      channels,
      llmProvider: llm,
      toolRegistry,
      maxTurns: 4,
      projectSummaryThreshold: 99,
    });

    await coordinator.tick();

    const createdTask = tasks.listTasks({ project: project.slug })[0];
    expect(createdTask).toBeDefined();
    expect(createdTask?.status).toBe("pending");
    expect(createdTask?.createdBy).toBe("coordinator");
    expect(createdTask?.sourceMessageId).toBe(coordinatorRequest.id);
    expect(messages.getMessage(coordinatorRequest.id)?.status).toBe("injected");
    expect(llm.calls[0]?.tools.map((tool) => tool.name)).toContain("create_task");

    llm.replaceToolInput("__TASK_ID__", createdTask!.id);

    await coordinator.tick();

    const assignedTask = tasks.getTask(createdTask!.id);
    expect(assignedTask?.status).toBe("assigned");
    expect(assignedTask?.assignedTo).toBe("coder");

    const worker = new AgentWorker({
      agent: agents.get("coder")!,
      tasks,
      messages,
      llmProvider: llm,
      toolRegistry,
      maxTurns: 3,
    });

    await worker.tick();

    const completedTask = tasks.getTask(createdTask!.id);
    expect(completedTask?.status).toBe("completed");
    expect(completedTask?.result).toBe("内部 E2E 已完成。");
    expect(messages.getMessage(projectContext.id)?.status).toBe("injected");
    expect(tasks.getTaskLogs(createdTask!.id).map((log) => log.eventType)).toContain("progress");
    expect(
      tasks.getTaskLogs(createdTask!.id).find((log) => log.eventType === "progress")?.content,
    ).toBe("已读取 Coordinator 创建的任务和项目上下文。");

    const workerCall = llm.calls.find((call) =>
      call.system.includes("Coder executes assigned implementation tasks."),
    );
    expect(workerCall?.system).toContain("<agent_soul>");
    expect(workerCall?.system).toContain("Coder executes assigned implementation tasks.");
    expect(workerCall?.tools.map((tool) => tool.name).sort()).toEqual([
      "read_file",
      REPORT_PROGRESS_TOOL,
      REQUEST_APPROVAL_TOOL,
    ].sort());
    expect(workerCall?.tools.map((tool) => tool.name)).not.toContain("create_task");
    expect(JSON.stringify(workerCall?.messages ?? [])).toContain(projectContext.content);
  });
  test("project channel message flows through coordinator and worker with results posted back", async () => {
    const project = channels.createChannel({
      slug: "research-project",
      title: "Research Project",
    });
    // Human sends a message in the project channel — this is the real frontend entry point
    const humanMessage = channels.postMessage(project.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "调研 Claude Code 实现原理并输出总结。",
    });

    const llm = new ScriptedLLM([
      // Coordinator: create_task tool call
      {
        type: "tool",
        name: "create_task",
        input: {
          title: "调研 Claude Code 实现原理",
          description: "Research Claude Code internals and produce a summary.",
          tags: ["code"],
          project: project.slug,
          channel_id: project.id,
          source_message_id: humanMessage.id,
        },
      },
      // Coordinator: text reply (posted to project channel)
      { type: "text", text: "已创建调研任务，正在分配给 coder。" },
      // Worker: text completion (result posted back to project channel)
      { type: "text", text: "Claude Code 实现原理总结：基于 ReAct 循环的智能体架构。" },
    ]);

    const coordinator = new CoordinatorLoop({
      agents,
      tasks,
      messages,
      channels,
      llmProvider: llm,
      toolRegistry,
      maxTurns: 4,
      projectSummaryThreshold: 99,
    });

    // Tick 1: Coordinator picks up project channel message, creates task
    await coordinator.tick();

    // Human message should be injected (consumed by coordinator)
    expect(messages.getMessage(humanMessage.id)?.status).toBe("injected");

    // Task should be created with pending status
    const createdTask = tasks.listTasks({ project: project.slug })[0];
    expect(createdTask).toBeDefined();
    expect(createdTask?.status).toBe("pending");
    expect(createdTask?.createdBy).toBe("coordinator");
    expect(createdTask?.project).toBe(project.slug);

    // Coordinator reply should be posted back to the project channel
    const coordinatorReplies = messages.listMessages({
      channelType: "project",
      project: project.slug,
    }).filter((m) => m.senderType === "coordinator");
    expect(coordinatorReplies).toHaveLength(1);
    expect(coordinatorReplies[0]?.content).toBe("已创建调研任务，正在分配给 coder。");
    expect(coordinatorReplies[0]?.status).toBe("resolved");

    // Tick 2: assignPendingTasks assigns the task to coder
    await coordinator.tick();

    const assignedTask = tasks.getTask(createdTask!.id);
    expect(assignedTask?.status).toBe("assigned");
    expect(assignedTask?.assignedTo).toBe("coder");

    // Worker picks up and completes the task
    const worker = new AgentWorker({
      agent: agents.get("coder")!,
      tasks,
      messages,
      llmProvider: llm,
      toolRegistry,
      maxTurns: 3,
    });

    await worker.tick();

    // Task should be completed
    const completedTask = tasks.getTask(createdTask!.id);
    expect(completedTask?.status).toBe("completed");
    expect(completedTask?.result).toBe("Claude Code 实现原理总结：基于 ReAct 循环的智能体架构。");

    // Agent result should be posted back to the project channel
    const agentReplies = messages.listMessages({
      channelType: "project",
      project: project.slug,
    }).filter((m) => m.senderType === "agent" && m.senderId === "coder");
    expect(agentReplies).toHaveLength(1);
    expect(agentReplies[0]?.content).toBe("Claude Code 实现原理总结：基于 ReAct 循环的智能体架构。");
    expect(agentReplies[0]?.status).toBe("resolved");

    // Verify the complete conversation flow in the project channel:
    // human message → coordinator reply → agent result
    const projectMessages = messages.listMessages({
      channelType: "project",
      project: project.slug,
    });
    const senderSequence = projectMessages.map((m) => `${m.senderType}:${m.senderId}`);
    expect(senderSequence).toContain("human:ceo");
    expect(senderSequence).toContain("coordinator:coordinator");
    expect(senderSequence).toContain("agent:coder");
  });

  test("rejected task does not block new project channel messages (E2E)", async () => {
    const project = channels.createChannel({
      slug: "rejection-project",
      title: "Rejection Project",
    });
    // Create a task that gets assigned and then rejected
    const task = tasks.createTask({
      title: "Rejected task",
      description: "This task will be rejected.",
      createdBy: "coordinator",
      project: project.slug,
      assignedTo: "coder",
      tags: ["code"],
    });
    tasks.startTask(task.id, "coder");
    tasks.requestApproval(task.id, { prompt: "May I proceed?", agentName: "coder" });
    tasks.rejectTask(task.id, "No, try a different approach.", "ceo");
    expect(tasks.getTask(task.id)?.status).toBe("rejected");

    // Human sends a new message — should NOT be blocked by the rejected task
    const newMessage = channels.postMessage(project.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "换一种方案来做吧。",
    });

    const llm = new ScriptedLLM([
      {
        type: "tool",
        name: "create_task",
        input: {
          title: "新方案任务",
          description: "Try a different approach.",
          tags: ["code"],
          project: project.slug,
          channel_id: project.id,
          source_message_id: newMessage.id,
        },
      },
      { type: "text", text: "已创建新方案任务。" },
    ]);

    const coordinator = new CoordinatorLoop({
      agents,
      tasks,
      messages,
      channels,
      llmProvider: llm,
      toolRegistry,
      maxTurns: 4,
      projectSummaryThreshold: 99,
    });

    await coordinator.tick();

    // The new message should be picked up (not blocked by rejected task)
    expect(messages.getMessage(newMessage.id)?.status).toBe("injected");
    expect(llm.calls.length).toBeGreaterThan(0);
  });
});

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

  replaceToolInput(placeholder: string, value: string): void {
    for (const reply of this.replies) {
      if (reply.type !== "tool") continue;
      for (const [key, item] of Object.entries(reply.input)) {
        if (item === placeholder) {
          reply.input[key] = value;
        }
      }
    }
  }

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
    return "scripted-team-internal-e2e-model";
  }

  setModel(_model: string): void {}
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} test tool`,
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      return { success: true, output: "ok" };
    },
  };
}
