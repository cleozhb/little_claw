import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import type { ChatOptions, LLMProvider } from "../../src/llm/types.ts";
import { AgentRegistry } from "../../src/team/AgentRegistry.ts";
import {
  createCoordinatorTools,
  ensureCoordinatorTools,
} from "../../src/team/CoordinatorTools.ts";
import { ProjectChannelStore } from "../../src/team/ProjectChannelStore.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import { TeamMessageStore } from "../../src/team/TeamMessageStore.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";

const TEST_DB = "/tmp/little_claw_coordinator_tools_test.db";

let db: Database;
let tasks: TaskQueue;
let messages: TeamMessageStore;
let channels: ProjectChannelStore;
let agents: AgentRegistry;
let agentDir: string;

beforeEach(() => {
  db = new Database(TEST_DB);
  tasks = new TaskQueue(db);
  messages = new TeamMessageStore(db);
  channels = new ProjectChannelStore(db, messages);
  agentDir = mkdtempSync(join(tmpdir(), "little-claw-coordinator-tools-agents-"));
  agents = new AgentRegistry(agentDir);
  agents.create("coordinator", {
    config: {
      name: "coordinator",
      role: "Coordinate team work.",
      task_tags: ["coordination"],
    },
    soul: "Coordinator soul.",
    operatingInstructions: "Coordinate through facts.",
  });
  agents.create("coder", {
    config: {
      name: "coder",
      role: "Write code.",
      aliases: ["dev"],
      task_tags: ["code"],
    },
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

describe("CoordinatorTools", () => {
  test("create_task, list_tasks, assign_task, and delegate_task use TaskQueue", async () => {
    const project = channels.createChannel({ slug: "lovely-octopus", title: "Lovely Octopus" });
    const tools = toolMap();
    const created = await getTool(tools, "create_task").execute({
      title: "Implement coordinator loop",
      description: "Wire deterministic assignment.",
      tags: ["code"],
      priority: 5,
      project: "lovely-octopus",
    });
    const createdTask = JSON.parse(created.output).task;

    expect(tasks.getTask(createdTask.id)?.status).toBe("pending");
    expect(tasks.getTask(createdTask.id)?.channelId).toBe(project.id);

    const listed = await getTool(tools, "list_tasks").execute({ status: "pending", tags: ["code"] });
    expect(JSON.parse(listed.output).tasks.map((task: { id: string }) => task.id)).toEqual([
      createdTask.id,
    ]);

    await getTool(tools, "assign_task").execute({ task_id: createdTask.id, agent_name: "coder" });
    expect(tasks.getTask(createdTask.id)?.assignedTo).toBe("coder");

    const child = await getTool(tools, "delegate_task").execute({
      parent_task_id: createdTask.id,
      title: "Write focused tests",
      description: "Add CoordinatorLoop coverage.",
      assigned_to: "coder",
      project: project.slug,
      tags: ["test"],
    });
    const childTask = JSON.parse(child.output).task;
    expect(tasks.getTask(createdTask.id)?.blocks).toEqual([childTask.id]);
    expect(tasks.getTask(childTask.id)?.createdBy).toBe("coordinator");
    expect(tasks.getTask(childTask.id)?.channelId).toBe(project.id);
  });

  test("send_message_to_agent and post_to_project_channel write team messages", async () => {
    const project = channels.createChannel({ slug: "lovely-octopus", title: "Lovely Octopus" });
    const tools = toolMap();

    const dm = await getTool(tools, "send_message_to_agent").execute({
      agent_name: "coder",
      content: "Please take the implementation task.",
      priority: "high",
    });
    const dmMessage = JSON.parse(dm.output).message;
    expect(messages.getMessage(dmMessage.id)?.channelType).toBe("agent_dm");
    expect(messages.getPendingForAgent("coder").map((message) => message.id)).toEqual([
      dmMessage.id,
    ]);

    const posted = await getTool(tools, "post_to_project_channel").execute({
      project: project.slug,
      content: "Coordinator posted a status update.",
    });
    const projectMessage = JSON.parse(posted.output).message;
    expect(messages.getMessage(projectMessage.id)?.project).toBe(project.slug);
    expect(channels.listMessages(project.slug).map((message) => message.id)).toEqual([
      projectMessage.id,
    ]);
  });

  test("message tools reject fake task ids", async () => {
    channels.createChannel({ slug: "lovely-octopus", title: "Lovely Octopus" });
    const tools = toolMap();

    await expect(
      getTool(tools, "send_message_to_agent").execute({
        agent_name: "coder",
        task_id: "499122df",
        content: "Do this fake task.",
      }),
    ).rejects.toThrow(/Unknown task_id/);

    await expect(
      getTool(tools, "post_to_project_channel").execute({
        project: "lovely-octopus",
        task_id: "499122df",
        content: "Fake task status.",
      }),
    ).rejects.toThrow(/Unknown task_id/);
  });

  test("summarize_project_channel uses the stateless LLM helper and posts summary", async () => {
    channels.createChannel({ slug: "ops", title: "Ops" });
    channels.postMessage("ops", {
      senderType: "human",
      senderId: "ceo",
      content: "We need a release checklist.",
    });
    const llm = new TextLLM("Summary: release checklist needed.");
    const tools = toolMap(llm);

    const result = await getTool(tools, "summarize_project_channel").execute({ project: "ops" });
    const summary = JSON.parse(result.output).summary;

    expect(summary.content).toBe("Summary: release checklist needed.");
    expect(messages.getMessage(summary.id)?.senderType).toBe("coordinator");
    expect(llm.lastTools).toEqual([]);
  });

  test("ensureCoordinatorTools registers tools once", () => {
    const registry = new ToolRegistry();
    ensureCoordinatorTools(registry, {
      tasks,
      messages,
      channels,
      agents,
    });
    ensureCoordinatorTools(registry, {
      tasks,
      messages,
      channels,
      agents,
    });

    expect(registry.getAll().map((tool) => tool.name).sort()).toContain("create_task");
    expect(registry.getAll().filter((tool) => tool.name === "create_task")).toHaveLength(1);
  });
});

function toolMap(llmProvider?: LLMProvider) {
  const tools = createCoordinatorTools({
    tasks,
    messages,
    channels,
    agents,
    llmProvider,
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<
    string,
    (typeof tools)[number]
  >;
}

function getTool(tools: Record<string, Tool>, name: string): Tool {
  const tool = tools[name];
  if (!tool) {
    throw new Error(`Missing test tool: ${name}`);
  }
  return tool;
}

class TextLLM implements LLMProvider {
  lastTools: NonNullable<ChatOptions["tools"]> = [];

  constructor(private response: string) {}

  async *chat(_messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    this.lastTools = options?.tools ?? [];
    yield { type: "text_delta", text: this.response };
    yield {
      type: "message_end",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }

  getModel(): string {
    return "text-test-model";
  }

  setModel(_model: string): void {}
}
