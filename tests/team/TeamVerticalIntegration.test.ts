import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentConfig } from "../../src/agents/AgentConfig.ts";
import { AgentLoop } from "../../src/core/AgentLoop.ts";
import { EphemeralConversation } from "../../src/core/EphemeralConversation.ts";
import { Database } from "../../src/db/Database.ts";
import type { ChatOptions, LLMProvider } from "../../src/llm/types.ts";
import { AgentRegistry, type RegisteredAgent } from "../../src/team/AgentRegistry.ts";
import { ProjectChannelStore } from "../../src/team/ProjectChannelStore.ts";
import type { Task } from "../../src/team/TaskQueue.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import { TeamMessageStore, type TeamMessage } from "../../src/team/TeamMessageStore.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";

const TEST_DB = "/tmp/little_claw_team_vertical_test.db";

let db: Database;
let messages: TeamMessageStore;
let channels: ProjectChannelStore;
let tasks: TaskQueue;
let registry: AgentRegistry;
let agentDir: string;

beforeEach(() => {
  db = new Database(TEST_DB);
  messages = new TeamMessageStore(db);
  channels = new ProjectChannelStore(db, messages);
  tasks = new TaskQueue(db);
  agentDir = mkdtempSync(join(tmpdir(), "little-claw-vertical-agents-"));
  registry = new AgentRegistry(agentDir);
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

describe("Team mode vertical integration", () => {
  test("assigned team task is executed through the existing AgentLoop", async () => {
    const agent = registry.create("coder", {
      config: {
        name: "coder",
        role: "Writes code for team tasks.",
        aliases: ["dev"],
        tools: ["allowed_tool"],
        task_tags: ["code"],
      },
      soul: "# Soul\nCoder soul from registry.\n",
      operatingInstructions: "# Agent Operating Instructions\nUse the team task context.\n",
    });
    const project = channels.createChannel({ slug: "lovely-octopus", title: "Lovely Octopus" });
    const task = tasks.createTask({
      title: "Fix routing bug",
      description: "Use the project context and report a concise result.",
      createdBy: "human",
      assignedTo: "coder",
      project: project.slug,
      channelId: project.id,
      tags: ["code"],
    });
    const projectMessage = channels.postMessage(project.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "补充：优先验证 TeamRouter 路由。",
      taskId: task.id,
    });
    const dmMessage = messages.createMessage({
      channelType: "agent_dm",
      channelId: "coder",
      senderType: "human",
      senderId: "ceo",
      content: "请直接复用现有 AgentLoop，不要新写执行循环。",
    });

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(fakeTool("allowed_tool"));
    toolRegistry.register(fakeTool("blocked_tool"));
    const llm = new CapturingLLM("已完成：通过 AgentLoop 执行。");

    const result = await runAssignedTaskThroughAgentLoop({
      agent,
      task,
      llm,
      toolRegistry,
      tasks,
      messages,
    });

    expect(result.status).toBe("completed");
    expect(result.result).toBe("已完成：通过 AgentLoop 执行。");
    expect(llm.chatCalls).toBe(1);
    expect(llm.lastSystem).toContain("<agent_soul>");
    expect(llm.lastSystem).toContain("Coder soul from registry.");
    expect(llm.lastSystem).toContain("<agent_operating_instructions>");
    expect(llm.lastSystem).toContain("Use the team task context.");
    expect(llm.lastMessages[0]?.role).toBe("user");
    expect(String(llm.lastMessages[0]?.content)).toContain("<task_context>");
    expect(String(llm.lastMessages[0]?.content)).toContain("Fix routing bug");
    expect(String(llm.lastMessages[0]?.content)).toContain(projectMessage.content);
    expect(String(llm.lastMessages[0]?.content)).toContain(dmMessage.content);
    expect(llm.lastTools.map((tool) => tool.name)).toEqual(["allowed_tool"]);
    expect(messages.getMessage(projectMessage.id)?.status).toBe("injected");
    expect(messages.getMessage(dmMessage.id)?.status).toBe("injected");
    expect(messages.getPendingForAgent("coder")).toEqual([]);
    expect(messages.getPendingForTask(task.id)).toEqual([]);
  });
});

async function runAssignedTaskThroughAgentLoop(params: {
  agent: RegisteredAgent;
  task: Task;
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  tasks: TaskQueue;
  messages: TeamMessageStore;
}): Promise<Task> {
  const running = params.tasks.startTask(params.task.id, params.agent.config.name);
  const injectableMessages = uniqueMessages([
    ...params.messages.getPendingForAgent(params.agent.config.name),
    ...params.messages.getPendingForProject(running.project ?? ""),
    ...params.messages.getPendingForTask(running.id),
  ]);
  const conversation = new EphemeralConversation("Lovely Octopus team task execution.");
  const loop = new AgentLoop(params.llm, params.toolRegistry, conversation, {
    config: createAgentConfig({
      name: params.agent.config.name,
      systemPrompt: buildTeamAgentSystemPrompt(params.agent),
      allowedTools: params.agent.config.tools,
      maxTurns: 2,
      canSpawnSubAgent: false,
    }),
  });

  let assistantText = "";
  for await (const event of loop.run(buildTaskUserPrompt(running, injectableMessages))) {
    if (event.type === "text_delta") {
      assistantText += event.text;
    }
  }

  for (const message of injectableMessages) {
    params.messages.markInjected(message.id, params.agent.config.name);
  }

  return params.tasks.completeTask(running.id, assistantText, params.agent.config.name);
}

function buildTeamAgentSystemPrompt(agent: RegisteredAgent): string {
  return `<agent_soul>
${agent.soul.trim()}
</agent_soul>

<agent_operating_instructions>
${agent.operatingInstructions.trim()}
</agent_operating_instructions>`;
}

function buildTaskUserPrompt(task: Task, teamMessages: TeamMessage[]): string {
  const messageBlock = teamMessages
    .map((message) => `- [${message.channelType}:${message.channelId}] ${message.senderId}: ${message.content}`)
    .join("\n");

  return `<task_context>
id: ${task.id}
title: ${task.title}
description: ${task.description}
project: ${task.project ?? "none"}
approval_response: ${task.approvalResponse ?? "none"}

recent_team_messages:
${messageBlock || "(none)"}
</task_context>`;
}

function uniqueMessages(items: TeamMessage[]): TeamMessage[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
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
