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
import { TeamScheduleStore } from "../../src/team/TeamScheduleStore.ts";
import { TeamMessageStore } from "../../src/team/TeamMessageStore.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import type { Tool } from "../../src/tools/types.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";

const TEST_DB = "/tmp/little_claw_coordinator_tools_test.db";

let db: Database;
let tasks: TaskQueue;
let messages: TeamMessageStore;
let channels: ProjectChannelStore;
let schedules: TeamScheduleStore;
let agents: AgentRegistry;
let agentDir: string;

beforeEach(() => {
  db = new Database(TEST_DB);
  tasks = new TaskQueue(db);
  messages = new TeamMessageStore(db);
  channels = new ProjectChannelStore(db, messages);
  schedules = new TeamScheduleStore(db);
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

  test("list_tasks limits output by default and supports active-only summaries", async () => {
    const tools = toolMap();
    const completed = tasks.createTask({
      title: "Completed arena task",
      description: "Old run.",
      createdBy: "coordinator",
      project: "arena",
      tags: ["arena"],
    });
    tasks.assignTask(completed.id, "coder");
    tasks.startTask(completed.id);
    tasks.completeTask(completed.id, "done", "coder");

    for (let index = 0; index < 25; index += 1) {
      tasks.createTask({
        title: `Pending arena task ${index}`,
        description: "Current or historical pending work.",
        createdBy: "coordinator",
        project: "arena",
        tags: ["arena"],
      });
    }

    const limited = await getTool(tools, "list_tasks").execute({
      project: "arena",
      tags: ["arena"],
    });
    const limitedParsed = JSON.parse(limited.output);

    expect(limitedParsed.total).toBe(26);
    expect(limitedParsed.returned).toBe(20);
    expect(limitedParsed.limit).toBe(20);
    expect(limitedParsed.truncated).toBe(true);
    expect(limitedParsed.summary.by_status.completed).toBe(1);

    const summary = await getTool(tools, "list_tasks").execute({
      project: "arena",
      tags: ["arena"],
      active_only: true,
      mode: "summary",
    });
    const summaryParsed = JSON.parse(summary.output);

    expect(summaryParsed.total).toBe(25);
    expect(summaryParsed.returned).toBe(0);
    expect(summaryParsed.tasks).toEqual([]);
    expect(summaryParsed.summary.active).toBe(25);
    expect(summaryParsed.summary.by_status.completed).toBeUndefined();
    expect(summaryParsed.summary.by_status.pending).toBe(25);
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

  test("create_task inherits project defaults from the current project channel", async () => {
    const project = channels.createChannel({ slug: "hello", title: "Hello" });
    const source = channels.postMessage(project.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "安排一个小测试。",
    });
    const tools = createCoordinatorTools({
      tasks,
      messages,
      channels,
      agents,
      getTaskDefaults: () => ({
        project: project.slug,
        channelId: project.id,
        sourceMessageId: source.id,
      }),
    });

    const created = await getTool(toolMapFromTools(tools), "create_task").execute({
      title: "实现防抖函数",
      description: "Write debounce.py and tests.",
      tags: ["code"],
      assigned_to: "coder",
    });
    const createdTask = JSON.parse(created.output).task;
    const stored = tasks.getTask(createdTask.id);

    expect(stored?.project).toBe(project.slug);
    expect(stored?.channelId).toBe(project.id);
    expect(stored?.sourceMessageId).toBe(source.id);
  });

  test("create_team_schedule writes an internal project cron schedule with channel defaults", async () => {
    const project = channels.createChannel({ slug: "health-management", title: "Health Management" });
    const source = channels.postMessage(project.slug, {
      senderType: "human",
      senderId: "mission-control",
      content: "最近眼睛干涩，提醒我每天14点滴眼药水",
    });
    const tools = createCoordinatorTools({
      tasks,
      messages,
      channels,
      agents,
      schedules,
      getTaskDefaults: () => ({
        project: project.slug,
        channelId: project.id,
        sourceMessageId: source.id,
      }),
    });

    const created = await getTool(toolMapFromTools(tools), "create_team_schedule").execute({
      name: "每日 14:00 眼药水提醒",
      agent_name: "coder",
      cron_expr: "0 14 * * *",
      prompt: "到时间提醒用户滴眼药水，并在项目频道简短回报。",
      tags: ["reminder", "health"],
      priority: 8,
    });
    const parsed = JSON.parse(created.output);
    const stored = schedules.getSchedule(parsed.schedule.id);

    expect(stored?.source).toBe("ui");
    expect(stored?.type).toBe("cron");
    expect(stored?.project).toBe(project.slug);
    expect(stored?.channelId).toBe(project.id);
    expect(stored?.cronExpr).toBe("0 14 * * *");
    expect(typeof stored?.nextRunAt).toBe("string");
  });

  test("create_task_dag creates a keyed dependency chain atomically", async () => {
    const project = channels.createChannel({ slug: "arena", title: "Arena" });
    const tools = toolMap();

    const created = await getTool(tools, "create_task_dag").execute({
      project: project.slug,
      active_conflict_tags: ["arena"],
      tasks: [
        {
          key: "blue",
          title: "Blue",
          description: "Write a defense.",
          tags: ["arena", "code"],
        },
        {
          key: "red",
          title: "Red",
          description: "Attack the defense.",
          tags: ["arena", "tinker"],
          depends_on: ["blue"],
        },
      ],
    });
    const parsed = JSON.parse(created.output);
    const blue = tasks.getTask(parsed.task_map.blue.id);
    const red = tasks.getTask(parsed.task_map.red.id);

    expect(parsed.created).toBe(true);
    expect(blue?.channelId).toBe(project.id);
    expect(red?.dependsOn).toEqual([blue!.id]);

    const conflict = await getTool(tools, "create_task_dag").execute({
      project: project.slug,
      active_conflict_tags: ["arena"],
      tasks: [
        {
          key: "another",
          title: "Another",
          description: "Should not be created while arena tasks are active.",
          tags: ["arena"],
        },
      ],
    });
    const conflictParsed = JSON.parse(conflict.output);

    expect(conflictParsed.created).toBe(false);
    expect(conflictParsed.reason).toBe("active_conflict");
    expect(tasks.listTasks({ project: project.slug })).toHaveLength(2);
  });

  test("create_task_dag rejects unknown dependency aliases without partial tasks", async () => {
    const tools = toolMap();

    await expect(
      getTool(tools, "create_task_dag").execute({
        project: "broken",
        tasks: [
          {
            key: "first",
            title: "First",
            description: "Would otherwise be partial.",
          },
          {
            key: "second",
            title: "Second",
            description: "References a missing dependency.",
            depends_on: ["missing"],
          },
        ],
      }),
    ).rejects.toThrow('Unknown task DAG dependency "missing"');

    expect(tasks.listTasks({ project: "broken" })).toEqual([]);
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
    expect(registry.getAll().map((tool) => tool.name).sort()).toContain("create_task_dag");
    expect(registry.getAll().filter((tool) => tool.name === "create_task")).toHaveLength(1);
    expect(registry.getAll().filter((tool) => tool.name === "create_task_dag")).toHaveLength(1);
  });
});

function toolMap(llmProvider?: LLMProvider) {
  const tools = createCoordinatorTools({
    tasks,
    messages,
    channels,
    agents,
    schedules,
    llmProvider,
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<
    string,
    (typeof tools)[number]
  >;
}

function toolMapFromTools(tools: Tool[]) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<string, Tool>;
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
  calls: Array<{ messages: Message[]; options?: ChatOptions }> = [];
  private responses: string[];
  private index = 0;

  constructor(response: string | string[]) {
    this.responses = Array.isArray(response) ? response : [response];
  }

  async *chat(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent> {
    this.lastTools = options?.tools ?? [];
    this.calls.push({ messages, options });
    const response = this.responses[Math.min(this.index, this.responses.length - 1)] ?? "";
    this.index += 1;
    yield { type: "text_delta", text: response };
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
