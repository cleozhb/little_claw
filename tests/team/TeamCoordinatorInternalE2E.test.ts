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
