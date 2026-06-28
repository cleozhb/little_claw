import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import type { ChatOptions, LLMProvider } from "../../src/llm/types.ts";
import { LocalEmbeddingProvider } from "../../src/memory/EmbeddingProvider.ts";
import { AgentRegistry } from "../../src/team/AgentRegistry.ts";
import { CoordinatorLoop } from "../../src/team/CoordinatorLoop.ts";
import { ProjectChannelStore } from "../../src/team/ProjectChannelStore.ts";
import { SkillConfigFile } from "../../src/skills/SkillConfigFile.ts";
import { SkillLoader } from "../../src/skills/SkillLoader.ts";
import { SkillManager } from "../../src/skills/SkillManager.ts";
import { SkillMarkdownParser } from "../../src/skills/SkillMarkdownParser.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import { TeamScheduleStore } from "../../src/team/TeamScheduleStore.ts";
import { TeamMessageStore } from "../../src/team/TeamMessageStore.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import type { Message, StreamEvent } from "../../src/types/message.ts";

const TEST_DB = "/tmp/little_claw_coordinator_loop_test.db";

let db: Database;
let tasks: TaskQueue;
let messages: TeamMessageStore;
let channels: ProjectChannelStore;
let schedules: TeamScheduleStore;
let agents: AgentRegistry;
let toolRegistry: ToolRegistry;
let agentDir: string;

class TestSkillLoader extends SkillLoader {
  constructor(private testDir: string) {
    super();
  }

  override async loadAll() {
    const parser = new SkillMarkdownParser();
    const glob = new Bun.Glob("*/SKILL.md");
    const results = [];

    for await (const match of glob.scan({
      cwd: this.testDir,
      absolute: true,
    })) {
      const parsed = await parser.parse(match);
      results.push({ parsed, source: match });
    }

    return results;
  }
}

beforeEach(() => {
  db = new Database(TEST_DB);
  tasks = new TaskQueue(db);
  messages = new TeamMessageStore(db);
  channels = new ProjectChannelStore(db, messages);
  schedules = new TeamScheduleStore(db);
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

  test("creates a coordinator-owned task for project channel messages without an owner", async () => {
    const channel = channels.createChannel({ slug: "lovely-octopus", title: "Lovely Octopus" });
    const inbound = channels.postMessage(channel.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "请创建一个任务来调查 pending 状态卡住的问题。",
    });
    const llm = new ScriptedLLM([{ type: "text", text: "should not run inline" }]);
    const loop = coordinatorLoop(llm);

    await loop.tick();

    const createdTask = tasks.listTasks({ project: channel.slug })[0];
    expect(createdTask?.status).toBe("assigned");
    expect(createdTask?.assignedTo).toBe("coordinator");
    expect(createdTask?.channelId).toBe(channel.id);
    expect(createdTask?.sourceMessageId).toBe(inbound.id);
    expect(createdTask?.description).toContain(inbound.content);
    expect(messages.getMessage(inbound.id)?.status).toBe("injected");
    expect(llm.calls).toHaveLength(0);
    expect(channels.listMessages(channel.slug).filter((message) => message.senderId === "coordinator")).toHaveLength(0);
  });

  test("project channel messages are delegated to the owning agent instead of coordinator execution", async () => {
    const skillsDir = join(agentDir, "skills");
    const podcastSkillDir = join(skillsDir, "podcast-translation-skill");
    const codeSkillDir = join(skillsDir, "code-helper");
    mkdirSync(podcastSkillDir, { recursive: true });
    mkdirSync(codeSkillDir, { recursive: true });
    writeFileSync(
      join(podcastSkillDir, "SKILL.md"),
      `---
name: podcast-translation-skill
description: Podcast curation and translation workflow for finding updated podcast episodes
tags:
  - podcast
  - translation
---

# Podcast Skill

podcast scoped marker
`,
    );
    writeFileSync(
      join(codeSkillDir, "SKILL.md"),
      `---
name: code-helper
description: Podcast unrelated TypeScript coding workflow
tags:
  - podcast
  - code
---

# Code Skill

code scoped marker
`,
    );
    writeFileSync(join(agentDir, "skill-config.json"), JSON.stringify({ skills: { entries: {} } }));
    createPodcastCurator();

    const config = new SkillConfigFile(join(agentDir, "skill-config.json"));
    await config.load();
    const skillManager = new SkillManager(
      new TestSkillLoader(skillsDir),
      config,
      { db, embeddingProvider: new LocalEmbeddingProvider() },
    );
    await skillManager.initializeAll();

    const channel = channels.createChannel({ slug: "podcast-translation", title: "Podcast Translation" });
    channels.postMessage(channel.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "看看有什么更新的播客",
    });
    const llm = new ScriptedLLM([{ type: "text", text: "我会查看更新的播客。" }]);
    const loop = coordinatorLoop(llm, { skillManager });

    await loop.tick();

    expect(llm.calls).toHaveLength(0);
    const task = tasks.listTasks({ project: "podcast-translation" })[0];
    expect(task?.assignedTo).toBe("podcast-curator");
    expect(task?.status).toBe("assigned");
    expect(task?.sourceMessageId).toBeDefined();
    expect(task?.description).toContain("看看有什么更新的播客");
  });

  test("project channel task creation inherits project context when the tool omits it", async () => {
    const channel = channels.createChannel({ slug: "hello", title: "Hello" });
    const inbound = messages.createMessage({
      channelType: "coordinator",
      channelId: "default",
      project: channel.slug,
      senderType: "human",
      senderId: "ceo",
      content: "再给 code agent 安排一个小测试。",
    });
    const llm = new ScriptedLLM([
      {
        type: "tool",
        name: "create_task",
        input: {
          title: "实现 Python 防抖函数",
          description: "Create debounce.py and tests.",
          tags: ["code"],
          assigned_to: "coder",
        },
      },
      { type: "text", text: "已安排防抖函数任务。" },
    ]);
    const loop = coordinatorLoop(llm);

    await loop.tick();

    const createdTask = tasks.listTasks({ project: channel.slug })[0];
    expect(createdTask?.title).toBe("实现 Python 防抖函数");
    expect(createdTask?.channelId).toBe(channel.id);
    expect(createdTask?.sourceMessageId).toBe(inbound.id);
    expect(tasks.listTasks().filter((task) => task.title === "实现 Python 防抖函数")).toHaveLength(1);
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
    const llm = new ScriptedLLM([{ type: "text", text: "should not run inline" }]);
    const loop = coordinatorLoop(llm);

    await loop.tick();

    expect(tasks.getTask(task.id)?.status).toBe("pending");
    expect(tasks.getTask(task.id)?.assignedTo).toBeUndefined();
    const createdTask = tasks
      .listTasks({ project: channel.slug })
      .find((item) => item.id !== task.id);
    expect(createdTask?.status).toBe("assigned");
    expect(createdTask?.assignedTo).toBe("coordinator");
    expect(createdTask?.description).toContain(inbound.content);
    expect(messages.getMessage(inbound.id)?.status).toBe("injected");
    expect(llm.calls).toHaveLength(0);
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
    const llm = new ScriptedLLM([{ type: "text", text: "should not run inline" }]);
    const loop = coordinatorLoop(llm);

    await loop.tick();

    // rejected 任务不应阻塞项目频道，新消息会进入新的 coordinator-owned task。
    const createdTask = tasks
      .listTasks({ project: channel.slug })
      .find((item) => item.id !== task.id);
    expect(createdTask?.status).toBe("assigned");
    expect(createdTask?.assignedTo).toBe("coordinator");
    expect(createdTask?.sourceMessageId).toBe(inbound.id);
    expect(messages.getMessage(inbound.id)?.status).toBe("injected");
    expect(llm.calls).toHaveLength(0);
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
    schedules,
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

function createPodcastCurator() {
  return agents.create("podcast-curator", {
    config: {
      name: "podcast-curator",
      role: "Curate and translate podcasts.",
      aliases: ["podcast", "curator"],
      default_project: "podcast-translation",
      tools: [],
      skills: ["podcast-translation-skill"],
      task_tags: ["podcast", "translation"],
      timeout_minutes: 1,
    },
    soul: "# Soul\nPodcast curator soul.\n",
    operatingInstructions: "# Agent Operating Instructions\nCurate podcast updates carefully.\n",
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
