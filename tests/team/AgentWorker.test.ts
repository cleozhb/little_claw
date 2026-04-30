import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Database } from "../../src/db/Database.ts";
import type { ChatOptions, LLMProvider } from "../../src/llm/types.ts";
import type { RegisteredAgent } from "../../src/team/AgentRegistry.ts";
import {
  AgentWorker,
  REPORT_PROGRESS_TOOL,
  REQUEST_APPROVAL_TOOL,
} from "../../src/team/AgentWorker.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import { TeamMessageStore } from "../../src/team/TeamMessageStore.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";

const TEST_DB = "/tmp/little_claw_agent_worker_test.db";

let db: Database;
let tasks: TaskQueue;
let messages: TeamMessageStore;
let toolRegistry: ToolRegistry;

beforeEach(() => {
  db = new Database(TEST_DB);
  tasks = new TaskQueue(db);
  messages = new TeamMessageStore(db);
  toolRegistry = new ToolRegistry();
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

describe("AgentWorker", () => {
  test("runs an assigned task through AgentLoop with team prompt and filtered tools", async () => {
    toolRegistry.register(fakeTool("allowed_tool"));
    toolRegistry.register(fakeTool("blocked_tool"));
    const llm = new ScriptedLLM([{ type: "text", text: "worker completed task" }]);
    const worker = new AgentWorker({
      agent: agent("coder", ["allowed_tool"]),
      tasks,
      messages,
      llmProvider: llm,
      toolRegistry,
      maxTurns: 2,
    });
    const task = tasks.createTask({
      title: "Fix routing bug",
      description: "Use the project context.",
      createdBy: "human",
      assignedTo: "coder",
      project: "lovely-octopus",
      tags: ["code"],
    });
    const projectMessage = messages.createMessage({
      channelType: "project",
      channelId: "lovely-octopus",
      project: "lovely-octopus",
      taskId: task.id,
      senderType: "human",
      senderId: "ceo",
      content: "补充：优先验证 TeamRouter 路由。",
    });
    const dmMessage = messages.createMessage({
      channelType: "agent_dm",
      channelId: "coder",
      senderType: "human",
      senderId: "ceo",
      content: "请复用现有 AgentLoop。",
    });

    await worker.tick();

    const completed = tasks.getTask(task.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toBe("worker completed task");
    expect(llm.lastSystem).toContain("<agent_soul>");
    expect(llm.lastSystem).toContain("Coder soul from registry.");
    expect(llm.lastSystem).toContain("<agent_operating_instructions>");
    expect(llm.lastSystem).toContain("Use the team task context.");
    expect(String(llm.lastMessages[0]?.content)).toContain("<task_context>");
    expect(String(llm.lastMessages[0]?.content)).toContain("Fix routing bug");
    expect(String(llm.lastMessages[0]?.content)).toContain(projectMessage.content);
    expect(String(llm.lastMessages[0]?.content)).toContain(dmMessage.content);
    expect(llm.lastTools.map((tool) => tool.name)).toEqual([
      "allowed_tool",
      REPORT_PROGRESS_TOOL,
      REQUEST_APPROVAL_TOOL,
    ]);
    expect(messages.getMessage(projectMessage.id)?.status).toBe("injected");
    expect(messages.getMessage(dmMessage.id)?.status).toBe("injected");
  });

  test("report_progress writes task logs while the AgentLoop owns tool execution", async () => {
    const task = tasks.createTask({
      title: "Implement worker",
      description: "Report progress before finishing.",
      createdBy: "human",
      assignedTo: "coder",
      tags: ["code"],
    });
    const llm = new ScriptedLLM([
      {
        type: "tool",
        name: REPORT_PROGRESS_TOOL,
        input: { task_id: task.id, content: "正在组装 AgentLoop 输入。" },
      },
      { type: "text", text: "done after progress" },
    ]);
    const worker = new AgentWorker({
      agent: agent("coder", []),
      tasks,
      messages,
      llmProvider: llm,
      toolRegistry,
      maxTurns: 3,
    });

    await worker.tick();

    expect(tasks.getTask(task.id)?.status).toBe("completed");
    expect(tasks.getTaskLogs(task.id).map((log) => log.eventType)).toContain("progress");
    expect(tasks.getTaskLogs(task.id).find((log) => log.eventType === "progress")?.content).toBe(
      "正在组装 AgentLoop 输入。",
    );
  });

  test("request_approval pauses a task and approved response resumes it as a user update", async () => {
    const task = tasks.createTask({
      title: "Publish result",
      description: "Needs approval before publishing.",
      createdBy: "human",
      assignedTo: "writer",
    });
    const llm = new ScriptedLLM([
      {
        type: "tool",
        name: REQUEST_APPROVAL_TOOL,
        input: { task_id: task.id, prompt: "可以发布吗？" },
      },
      { type: "text", text: "published after approval" },
    ]);
    const worker = new AgentWorker({
      agent: agent("writer", []),
      tasks,
      messages,
      llmProvider: llm,
      toolRegistry,
      maxTurns: 3,
    });

    await worker.tick();
    expect(tasks.getTask(task.id)?.status).toBe("awaiting_approval");
    expect(tasks.getTask(task.id)?.approvalPrompt).toBe("可以发布吗？");

    tasks.approveTask(task.id, "Approved by CEO.", "human");
    await worker.tick();

    expect(tasks.getTask(task.id)?.status).toBe("completed");
    expect(tasks.getTask(task.id)?.result).toContain("published after approval");
    const resumePrompt = String(llm.calls[1]?.messages.at(-1)?.content);
    expect(resumePrompt).toContain("Human approval status: approved");
    expect(resumePrompt).toContain("Approved by CEO.");
  });

  test("rejected approval resumes the task with the rejection reason", async () => {
    const task = tasks.createTask({
      title: "Select podcast",
      description: "Ask before choosing.",
      createdBy: "human",
      assignedTo: "researcher",
    });
    const llm = new ScriptedLLM([
      {
        type: "tool",
        name: REQUEST_APPROVAL_TOOL,
        input: { task_id: task.id, prompt: "选这个节目可以吗？" },
      },
      { type: "text", text: "revised plan after rejection" },
    ]);
    const worker = new AgentWorker({
      agent: agent("researcher", []),
      tasks,
      messages,
      llmProvider: llm,
      toolRegistry,
      maxTurns: 3,
    });

    await worker.tick();
    tasks.rejectTask(task.id, "换一个技术向节目。", "human");
    await worker.tick();

    expect(tasks.getTask(task.id)?.status).toBe("completed");
    const resumePrompt = String(llm.calls[1]?.messages.at(-1)?.content);
    expect(resumePrompt).toContain("Human approval status: rejected");
    expect(resumePrompt).toContain("换一个技术向节目。");
  });

  test("running human messages are injected once at AgentLoop checkpoints", async () => {
    toolRegistry.register(delayedTool("slow_tool", 50));
    const task = tasks.createTask({
      title: "Long task",
      description: "Use running updates.",
      createdBy: "human",
      assignedTo: "coder",
    });
    const llm = new ScriptedLLM([
      { type: "tool", name: "slow_tool", input: {} },
      { type: "text", text: "done with update" },
    ]);
    const worker = new AgentWorker({
      agent: agent("coder", ["slow_tool"]),
      tasks,
      messages,
      llmProvider: llm,
      toolRegistry,
      pollIntervalMs: 5,
      maxTurns: 3,
    });

    const run = worker.tick();
    await sleep(10);
    const update = messages.createMessage({
      channelType: "agent_dm",
      channelId: "coder",
      taskId: task.id,
      senderType: "human",
      senderId: "ceo",
      content: "运行中补充：先检查边界条件。",
    });
    await run;

    expect(messages.getMessage(update.id)?.status).toBe("injected");
    const secondCallMessages = JSON.stringify(llm.calls[1]?.messages ?? []);
    expect(countOccurrences(secondCallMessages, update.content)).toBe(1);
    expect(messages.getPendingForAgent("coder")).toEqual([]);
  });

  test("cancel control message aborts the current loop and cancels the task", async () => {
    toolRegistry.register(delayedTool("slow_tool", 100));
    const task = tasks.createTask({
      title: "Cancelable task",
      description: "Abort when requested.",
      createdBy: "human",
      assignedTo: "coder",
    });
    const llm = new ScriptedLLM([
      { type: "tool", name: "slow_tool", input: {} },
      { type: "text", text: "should not complete" },
    ]);
    const worker = new AgentWorker({
      agent: agent("coder", ["slow_tool"]),
      tasks,
      messages,
      llmProvider: llm,
      toolRegistry,
      pollIntervalMs: 5,
      maxTurns: 3,
    });

    const run = worker.tick();
    await sleep(10);
    const cancel = messages.createMessage({
      channelType: "agent_dm",
      channelId: "coder",
      senderType: "human",
      senderId: "ceo",
      content: "/cancel stop now",
    });
    await run;

    expect(tasks.getTask(task.id)?.status).toBe("cancelled");
    expect(messages.getMessage(cancel.id)?.status).toBe("resolved");
  });
});

function agent(name: string, tools: string[]): RegisteredAgent {
  return {
    config: {
      name,
      display_name: name,
      role: "Test agent",
      status: "active",
      aliases: [],
      direct_message: true,
      tools,
      skills: [],
      task_tags: ["code"],
      cron_jobs: [],
      requires_approval: [],
      max_concurrent_tasks: 2,
      max_tokens_per_task: 50000,
      timeout_minutes: 30,
    },
    soul: "# Soul\nCoder soul from registry.\n",
    operatingInstructions: "# Agent Operating Instructions\nUse the team task context.\n",
    currentTasks: [],
    status: "idle",
  };
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

  get lastMessages(): Message[] {
    return this.calls.at(-1)?.messages ?? [];
  }

  get lastSystem(): string {
    return this.calls.at(-1)?.system ?? "";
  }

  get lastTools(): NonNullable<ChatOptions["tools"]> {
    return this.calls.at(-1)?.tools ?? [];
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
    return "scripted-test-model";
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

function delayedTool(name: string, delayMs: number): Tool {
  return {
    name,
    description: `${name} delayed test tool`,
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_params, options) {
      await sleep(delayMs, options?.signal);
      return { success: true, output: `${name} done` };
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
