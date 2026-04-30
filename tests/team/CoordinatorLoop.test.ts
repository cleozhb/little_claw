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
