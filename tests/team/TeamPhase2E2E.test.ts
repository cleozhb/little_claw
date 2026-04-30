import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import type { ChatOptions, LLMProvider } from "../../src/llm/types.ts";
import { AgentRegistry } from "../../src/team/AgentRegistry.ts";
import { AgentWorker, REPORT_PROGRESS_TOOL, REQUEST_APPROVAL_TOOL } from "../../src/team/AgentWorker.ts";
import { ProjectChannelStore } from "../../src/team/ProjectChannelStore.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import { TeamMessageStore } from "../../src/team/TeamMessageStore.ts";
import { TeamRouter } from "../../src/team/TeamRouter.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";

const TEST_DB = "/tmp/little_claw_team_phase2_e2e_test.db";

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
  agentDir = mkdtempSync(join(tmpdir(), "little-claw-phase2-agents-"));
  registry = new AgentRegistry(agentDir);
  registry.create("coder", {
    config: {
      name: "coder",
      role: "Writes code for team tasks.",
      aliases: ["dev"],
      direct_message: true,
      task_tags: ["code"],
      tools: ["read_file"],
    },
    soul: "# Soul\nTeam coder soul.\n",
    operatingInstructions: "# Operating\nUse routed human messages as task context.\n",
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

describe("Lovely Octopus Phase 2 E2E", () => {
  test("routes a human @agent message, then AgentWorker executes the assigned task through AgentLoop", async () => {
    const routed = router.routeHumanMessage({
      externalChannel: "feishu",
      externalChatId: "chat-phase2",
      externalMessageId: "phase2-message-1",
      userId: "ceo",
      text: "@dev 修复 TeamRouter 到 AgentWorker 的端到端路径",
    });
    const routedMessage = messages.getMessage(routed.messageId);

    expect(routed.routedTo).toEqual({ type: "agent", id: "coder" });
    expect(routedMessage?.channelType).toBe("agent_dm");
    expect(routedMessage?.channelId).toBe("coder");
    expect(routedMessage?.status).toBe("routed");

    const task = tasks.createTask({
      title: "Fix Team Phase 2 path",
      description: "Use the routed human DM as context and complete the task.",
      createdBy: "human",
      assignedTo: "coder",
      sourceMessageId: routed.messageId,
      tags: ["code"],
    });
    const llm = new CapturingLLM("端到端任务已完成。");
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(fakeTool("read_file"));
    const worker = new AgentWorker({
      agent: registry.get("coder")!,
      tasks,
      messages,
      llmProvider: llm,
      toolRegistry,
      maxTurns: 2,
    });

    await worker.tick();

    const completed = tasks.getTask(task.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toBe("端到端任务已完成。");
    expect(messages.getMessage(routed.messageId)?.status).toBe("injected");
    expect(messages.getPendingForAgent("coder")).toEqual([]);
    expect(llm.chatCalls).toBe(1);
    expect(llm.lastSystem).toContain("<agent_soul>");
    expect(llm.lastSystem).toContain("Team coder soul.");
    expect(llm.lastSystem).toContain("<agent_operating_instructions>");
    expect(llm.lastSystem).toContain("Use routed human messages as task context.");
    expect(String(llm.lastMessages[0]?.content)).toContain("<task_context>");
    expect(String(llm.lastMessages[0]?.content)).toContain("Fix Team Phase 2 path");
    expect(String(llm.lastMessages[0]?.content)).toContain(routedMessage?.content ?? "");
    expect(llm.lastTools.map((tool) => tool.name)).toEqual([
      "read_file",
      REPORT_PROGRESS_TOOL,
      REQUEST_APPROVAL_TOOL,
    ]);
  });
});

class CapturingLLM implements LLMProvider {
  chatCalls = 0;
  lastMessages: Message[] = [];
  lastSystem = "";
  lastTools: NonNullable<ChatOptions["tools"]> = [];

  constructor(private response: string) {}

  async *chat(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    this.chatCalls += 1;
    this.lastMessages = [...messages];
    this.lastSystem = options?.system ?? "";
    this.lastTools = options?.tools ?? [];
    yield { type: "text_delta", text: this.response };
    yield {
      type: "message_end",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }

  getModel(): string {
    return "capturing-test-model";
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
