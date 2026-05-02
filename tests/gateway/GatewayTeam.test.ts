import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import { GatewayServer } from "../../src/gateway/GatewayServer.ts";
import { parseClientMessage } from "../../src/gateway/protocol.ts";
import type { LLMProvider } from "../../src/llm/types.ts";
import { ContextHub } from "../../src/memory/ContextHub.ts";
import { AgentRegistry } from "../../src/team/AgentRegistry.ts";
import { ProjectChannelStore } from "../../src/team/ProjectChannelStore.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import { TeamMessageStore } from "../../src/team/TeamMessageStore.ts";
import { TeamRouter } from "../../src/team/TeamRouter.ts";
import { TeamScheduleAdapter } from "../../src/team/TeamScheduleAdapter.ts";
import { TeamScheduleStore } from "../../src/team/TeamScheduleStore.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";

const TEST_DB = "/tmp/little_claw_gateway_team_test.db";

let db: Database;
let agentDir: string;
let contextDir: string;
let registry: AgentRegistry;
let messages: TeamMessageStore;
let channels: ProjectChannelStore;
let tasks: TaskQueue;
let schedules: TeamScheduleStore;
let scheduleAdapter: TeamScheduleAdapter;
let router: TeamRouter;
let gateway: GatewayServer;
let sent: any[];

const llmProvider: LLMProvider = {
  async *chat() {},
  getModel() {
    return "test-model";
  },
  setModel() {},
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  db = new Database(TEST_DB);
  agentDir = mkdtempSync(join(tmpdir(), "little-claw-gateway-agents-"));
  contextDir = mkdtempSync(join(tmpdir(), "little-claw-gateway-context-"));
  registry = new AgentRegistry(agentDir);
  registry.create("coder", {
    config: {
      name: "coder",
      role: "Writes code",
      aliases: ["dev"],
      direct_message: true,
      task_tags: ["code"],
      tools: [],
    },
  });
  registry.loadAll();
  messages = new TeamMessageStore(db);
  channels = new ProjectChannelStore(db, messages);
  tasks = new TaskQueue(db);
  schedules = new TeamScheduleStore(db);
  router = new TeamRouter({
    agentRegistry: registry,
    taskQueue: tasks,
    messages,
    projectChannels: channels,
  });
  scheduleAdapter = new TeamScheduleAdapter({
    schedules,
    agents: registry,
    tasks,
  });
  gateway = new GatewayServer({
    db,
    toolRegistry: new ToolRegistry(),
    llmProvider,
    teamRouter: router,
    teamMessages: messages,
    projectChannels: channels,
    taskQueue: tasks,
    agentRegistry: registry,
    teamSchedules: schedules,
    teamScheduleAdapter: scheduleAdapter,
    contextHub: new ContextHub(contextDir),
  });
  sent = [];
  (gateway as any).connections.set("conn-1", {
    send(raw: string) {
      sent.push(JSON.parse(raw));
    },
  });
});

afterEach(() => {
  db.close();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(contextDir, { recursive: true, force: true });
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

describe("Gateway team protocol", () => {
  test("parses new team client messages", () => {
    expect(parseClientMessage(JSON.stringify({
      type: "route_human_message",
      text: "@dev 修复 bug",
      externalChannel: "websocket",
      externalChatId: "conn-1",
    })).type).toBe("route_human_message");

    expect(parseClientMessage(JSON.stringify({
      type: "list_tasks",
      status: "awaiting_approval",
      tags: ["code"],
    })).type).toBe("list_tasks");

    expect(() => parseClientMessage(JSON.stringify({
      type: "approve_task",
    }))).toThrow("'taskId' must be a non-empty string");

    expect(parseClientMessage(JSON.stringify({
      type: "get_agent_detail",
      name: "coder",
    })).type).toBe("get_agent_detail");

    expect(parseClientMessage(JSON.stringify({
      type: "create_project_channel",
      slug: "new-project",
      title: "New Project",
    })).type).toBe("create_project_channel");

    expect(parseClientMessage(JSON.stringify({
      type: "list_team_schedules",
      agentName: "coder",
    })).type).toBe("list_team_schedules");

    expect(parseClientMessage(JSON.stringify({
      type: "run_team_schedule_now",
      scheduleId: "schedule-1",
    })).type).toBe("run_team_schedule_now");

    expect(parseClientMessage(JSON.stringify({
      type: "update_team_schedule",
      scheduleId: "schedule-1",
      updates: { enabled: false },
    })).type).toBe("update_team_schedule");

    expect(() => parseClientMessage(JSON.stringify({
      type: "update_team_schedule",
      scheduleId: "schedule-1",
    }))).toThrow("'updates' must be an object");

    expect(() => parseClientMessage(JSON.stringify({
      type: "update_team_schedule",
      scheduleId: "schedule-1",
      updates: { enabled: "false" },
    }))).toThrow("'enabled' must be a boolean if provided");
  });

  test("routes websocket human messages through TeamRouter", () => {
    (gateway as any).dispatch("conn-1", {
      type: "route_human_message",
      text: "@dev 修复 TeamRouter",
      userId: "ceo",
    });

    const routed = sent.find((msg) => msg.type === "human_message_routed");
    const pushed = sent.find((msg) => msg.type === "team_message_added");

    expect(routed?.result.routedTo).toEqual({ type: "agent", id: "coder" });
    expect(routed?.message.channelType).toBe("agent_dm");
    expect(routed?.message.channelId).toBe("coder");
    expect(pushed?.message.id).toBe(routed?.message.id);
  });

  test("lists project channels and messages", () => {
    (gateway as any).dispatch("conn-1", {
      type: "send_project_message",
      project: "lovely-octopus",
      content: "推进 Gateway 集成",
      userId: "ceo",
    });
    (gateway as any).dispatch("conn-1", {
      type: "list_project_channels",
    });
    (gateway as any).dispatch("conn-1", {
      type: "get_project_channel",
      project: "lovely-octopus",
    });

    const channelsList = sent.find((msg) => msg.type === "project_channels_list");
    const loaded = sent.find((msg) => msg.type === "project_channel_loaded");

    expect(channelsList?.channels.map((channel: any) => channel.slug)).toContain("lovely-octopus");
    expect(loaded?.channel.slug).toBe("lovely-octopus");
    expect(loaded?.messages[0].content).toBe("推进 Gateway 集成");
  });

  test("loads team agent file details", () => {
    (gateway as any).dispatch("conn-1", {
      type: "list_agents",
    });
    (gateway as any).dispatch("conn-1", {
      type: "get_agent_detail",
      name: "coder",
    });

    const listed = sent.find((msg) => msg.type === "agents_list");
    const detail = sent.find((msg) => msg.type === "agent_detail_loaded");

    expect(listed?.agents[0]?.source).toBe("team");
    expect(detail?.agent.name).toBe("coder");
    expect(detail?.agent.agentYaml).toContain("name: coder");
    expect(detail?.agent.soul).toContain("# Soul");
    expect(detail?.agent.agentsMd).toContain("# Agent Operating Instructions");
  });

  test("creates project channels with a context-hub project path", async () => {
    (gateway as any).dispatch("conn-1", {
      type: "create_project_channel",
      slug: "new-project",
      title: "New Project",
      description: "Launch plan.",
    });
    await sleep(20);

    const created = sent.find((msg) => msg.type === "project_channel_created");
    const listed = sent.find((msg) => msg.type === "project_channels_list");
    const hub = new ContextHub(contextDir);

    expect(created?.channel.slug).toBe("new-project");
    expect(created?.channel.contextPath).toBe("context-hub/3-projects/new-project");
    expect(listed?.channels.map((channel: any) => channel.slug)).toContain("new-project");
    expect(await hub.readOverview("3-projects/new-project")).toContain("# New Project");
    expect(await hub.readFile("3-projects/new-project/status.md")).toContain("Project channel created");
  });

  test("broadcasts non-human team messages created by workers", () => {
    messages.createMessage({
      channelType: "agent_dm",
      channelId: "coder",
      senderType: "agent",
      senderId: "coder",
      content: "worker reply",
    });

    const pushed = sent.find((msg) => msg.type === "team_message_added");
    expect(pushed?.message.senderType).toBe("agent");
    expect(pushed?.message.content).toBe("worker reply");
  });

  test("updates tasks through gateway approval handlers", () => {
    const task = tasks.createTask({
      title: "Publish",
      description: "Needs approval",
      createdBy: "ceo",
      assignedTo: "coder",
    });
    tasks.startTask(task.id);
    tasks.requestApproval(task.id, { prompt: "Publish?" });
    sent = [];

    (gateway as any).dispatch("conn-1", {
      type: "approve_task",
      taskId: task.id,
      response: "可以发",
      userId: "ceo",
    });

    expect(tasks.getTask(task.id)?.status).toBe("approved");
    expect(sent.some((msg) => msg.type === "task_updated" && msg.task.status === "approved")).toBe(true);
  });

  test("lists and runs team schedules through gateway handlers", () => {
    const schedule = schedules.createSchedule({
      type: "cron",
      name: "Code health",
      agentName: "coder",
      prompt: "Check code health",
      cronExpr: "0 8 * * *",
      tags: ["code"],
    });
    sent = [];

    (gateway as any).dispatch("conn-1", {
      type: "list_team_schedules",
      agentName: "coder",
    });
    (gateway as any).dispatch("conn-1", {
      type: "run_team_schedule_now",
      scheduleId: schedule.id,
    });
    (gateway as any).dispatch("conn-1", {
      type: "get_team_schedule_runs",
      scheduleId: schedule.id,
    });

    const list = sent.find((msg) => msg.type === "team_schedules_list");
    const triggered = sent.find((msg) => msg.type === "team_schedule_triggered");
    const runs = sent.find((msg) => msg.type === "team_schedule_runs");

    expect(list?.schedules).toHaveLength(1);
    expect(triggered?.run.status).toBe("created");
    expect(triggered?.task.assignedTo).toBe("coder");
    expect(runs?.runs).toHaveLength(1);
  });

  test("updates team schedules through gateway handlers", () => {
    const schedule = schedules.createSchedule({
      type: "cron",
      name: "Code health",
      agentName: "coder",
      prompt: "Check code health",
      cronExpr: "0 8 * * *",
      tags: ["code"],
    });
    sent = [];

    (gateway as any).dispatch("conn-1", {
      type: "update_team_schedule",
      scheduleId: schedule.id,
      updates: { enabled: false },
    });

    expect(schedules.getSchedule(schedule.id)?.enabled).toBe(false);
    expect(sent.some((msg) => msg.type === "team_schedule_updated" && msg.schedule.enabled === false)).toBe(true);
  });

  test("rejects malformed team schedule updates without throwing", () => {
    const schedule = schedules.createSchedule({
      type: "cron",
      name: "Code health",
      agentName: "coder",
      prompt: "Check code health",
      cronExpr: "0 8 * * *",
    });
    sent = [];

    expect(() => (gateway as any).dispatch("conn-1", {
      type: "update_team_schedule",
      scheduleId: schedule.id,
    })).not.toThrow();

    expect(sent.some((msg) => msg.type === "error" && msg.message.includes("updates must be an object"))).toBe(true);
  });

  test("feishu webhook enters TeamRouter and sends ack without running session chat", async () => {
    const acks: string[] = [];
    (gateway as any).feishuAdapter = {
      decryptBody(body: Record<string, unknown>) {
        return body;
      },
      handleChallenge() {
        return null;
      },
      verifyToken() {
        return true;
      },
      parseToInternal() {
        return {
          channelType: "feishu",
          chatId: "chat-1",
          externalMessageId: "event-1",
          userId: "open-1",
          text: "@dev 修复飞书入口",
        };
      },
      async sendToChannel(_chatId: string, content: string) {
        acks.push(content);
      },
    };

    const response = await (gateway as any).handleFeishuWebhook(
      new Request("http://localhost/webhook/feishu", {
        method: "POST",
        body: JSON.stringify({ ok: true }),
      }),
    );
    await Bun.sleep(0);

    expect(response.status).toBe(200);
    expect(acks[0]).toContain("@coder");
    expect(messages.listMessages({ channelType: "agent_dm", channelId: "coder" }).length).toBe(1);
  });
});
