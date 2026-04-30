import type { AgentRegistry, RegisteredAgent } from "./AgentRegistry.ts";
import type { ProjectChannel, ProjectChannelStore } from "./ProjectChannelStore.ts";
import type { Task, TaskQueue } from "./TaskQueue.ts";
import type { TeamChannelType, TeamMessage, TeamMessageStore } from "./TeamMessageStore.ts";

export interface RouteHumanMessageInput {
  externalChannel: string;
  externalChatId: string;
  externalMessageId?: string;
  userId: string;
  text: string;
}

export type RouteTarget =
  | { type: "agent"; id: string }
  | { type: "project"; id: string }
  | { type: "task"; id: string }
  | { type: "coordinator"; id: string }
  | { type: "system"; id: string };

export interface RouteResult {
  messageId: string;
  ack: string;
  routedTo: RouteTarget;
  asyncWorkStarted: boolean;
}

export interface TeamRouterDeps {
  agentRegistry: AgentRegistry;
  taskQueue: TaskQueue;
  messages: TeamMessageStore;
  projectChannels: ProjectChannelStore;
}

type ParsedCommand =
  | { type: "task"; taskId: string; action: "approve" | "reject" | "cancel"; response: string }
  | { type: "pause" | "resume"; agentToken: string }
  | { type: "project"; slug: string }
  | { type: "status"; target?: string };

type ParsedMention = { agent: RegisteredAgent; body: string };
type ParsedProject = { channel: ProjectChannel; body: string };

const ROUTER_ID = "team-router";

/**
 * 人类团队消息的确定性第一站。
 *
 * TeamRouter 不调用 LLM：它先记录每一条人类输入，再用规则处理控制命令，
 * 普通消息只负责路由到对应团队频道，后续由 worker/coordinator 循环注入上下文。
 */
export class TeamRouter {
  private agentRegistry: AgentRegistry;
  private taskQueue: TaskQueue;
  private messages: TeamMessageStore;
  private projectChannels: ProjectChannelStore;

  constructor(deps: TeamRouterDeps) {
    this.agentRegistry = deps.agentRegistry;
    this.taskQueue = deps.taskQueue;
    this.messages = deps.messages;
    this.projectChannels = deps.projectChannels;
  }

  routeHumanMessage(input: RouteHumanMessageInput): RouteResult {
    const text = input.text.trim();

    // 所有入口先落库，默认放到 coordinator inbox；后续路由只更新这条消息的目标频道。
    const message = this.messages.createMessage({
      channelType: "coordinator",
      channelId: "inbox",
      senderType: "human",
      senderId: input.userId,
      content: text || "[empty message]",
      externalChannel: input.externalChannel,
      externalChatId: input.externalChatId,
      externalMessageId: input.externalMessageId,
    });

    // 外部平台可能重试同一事件；去重命中时不能再次执行 approve/cancel 等有副作用命令。
    if (message.status !== "new") {
      return {
        messageId: message.id,
        ack: "已收到。重复消息已忽略。",
        routedTo: routeTargetFromMessage(message),
        asyncWorkStarted: false,
      };
    }

    const command = parseCommand(text);
    if (command) return this.routeCommand(message, input, command);

    // 没有显式 /task 时，允许人类直接回复“同意/拒绝”来处理当前等待审批任务。
    const approval = this.routeApprovalReply(message, input, text);
    if (approval) return approval;

    const mention = this.parseAgentMention(text);
    if (mention) {
      this.messages.routeMessage(message.id, {
        channelType: "agent_dm",
        channelId: mention.agent.config.name,
        routedBy: ROUTER_ID,
      });
      return {
        messageId: message.id,
        ack: `已转给 @${mention.agent.config.name}。`,
        routedTo: { type: "agent", id: mention.agent.config.name },
        asyncWorkStarted: false,
      };
    }

    // 显式项目频道优先于外部 chat 绑定，方便同一个群里临时切换话题。
    const project = this.parseProjectMention(text);
    if (project) {
      this.messages.routeMessage(message.id, {
        channelType: "project",
        channelId: project.channel.id,
        project: project.channel.slug,
        routedBy: ROUTER_ID,
      });
      return {
        messageId: message.id,
        ack: `已发到 #${project.channel.slug}。`,
        routedTo: { type: "project", id: project.channel.slug },
        asyncWorkStarted: false,
      };
    }

    const binding = this.projectChannels.resolveExternalChat(
      input.externalChannel,
      input.externalChatId,
    );
    // 飞书群或 WebSocket 会话绑定项目后，普通消息自动进入该项目频道。
    if (binding?.channelType === "project") {
      const channel = this.projectChannels.getChannel(binding.channelId);
      const projectId = channel?.slug ?? binding.channelId;
      this.messages.routeMessage(message.id, {
        channelType: "project",
        channelId: binding.channelId,
        project: projectId,
        routedBy: ROUTER_ID,
      });
      return {
        messageId: message.id,
        ack: `已发到 #${projectId}。`,
        routedTo: { type: "project", id: projectId },
        asyncWorkStarted: false,
      };
    }

    if (binding?.channelType === "agent_dm") {
      this.messages.routeMessage(message.id, {
        channelType: "agent_dm",
        channelId: binding.channelId,
        routedBy: ROUTER_ID,
      });
      return {
        messageId: message.id,
        ack: `已转给 @${binding.channelId}。`,
        routedTo: { type: "agent", id: binding.channelId },
        asyncWorkStarted: false,
      };
    }

    // 无明确目标时进入 coordinator，由后续协调逻辑拆分任务或询问人类。
    this.messages.routeMessage(message.id, {
      channelType: "coordinator",
      channelId: "default",
      routedBy: ROUTER_ID,
    });
    return {
      messageId: message.id,
      ack: "已交给 coordinator 处理。",
      routedTo: { type: "coordinator", id: "default" },
      asyncWorkStarted: false,
    };
  }

  private routeCommand(
    message: TeamMessage,
    input: RouteHumanMessageInput,
    command: ParsedCommand,
  ): RouteResult {
    switch (command.type) {
      case "task":
        return this.routeTaskCommand(message, input.userId, command);
      case "pause":
      case "resume":
        return this.routeAgentStateCommand(message, command);
      case "project":
        return this.routeProjectCommand(message, input, command.slug);
      case "status":
        return this.routeStatusCommand(message, command.target);
    }
  }

  private routeTaskCommand(
    message: TeamMessage,
    userId: string,
    command: Extract<ParsedCommand, { type: "task" }>,
  ): RouteResult {
    try {
      // 控制命令直接改任务状态，不进入 LLM，也不等待 worker 做异步处理。
      if (command.action === "approve") {
        this.taskQueue.approveTask(command.taskId, command.response || "Approved.", userId);
      } else if (command.action === "reject") {
        this.taskQueue.rejectTask(command.taskId, command.response || "Rejected.", userId);
      } else {
        this.taskQueue.cancelTask(command.taskId, command.response || undefined, userId);
      }

      this.messages.routeMessage(message.id, {
        channelType: "coordinator",
        channelId: "tasks",
        taskId: command.taskId,
        routedBy: ROUTER_ID,
      });
      this.messages.markResolved(message.id, ROUTER_ID);

      return {
        messageId: message.id,
        ack: taskCommandAck(command),
        routedTo: { type: "task", id: command.taskId },
        asyncWorkStarted: false,
      };
    } catch (err) {
      return this.routeSystemError(message, taskCommandErrorAck(command, err));
    }
  }

  private routeAgentStateCommand(
    message: TeamMessage,
    command: Extract<ParsedCommand, { type: "pause" | "resume" }>,
  ): RouteResult {
    const agent = this.resolveAgent(command.agentToken);
    if (!agent) {
      return this.routeSystemError(message, `没有找到 agent：${command.agentToken}。`);
    }

    try {
      this.agentRegistry.update(agent.config.name, {
        config: { status: command.type === "pause" ? "paused" : "active" },
      });
      this.messages.routeMessage(message.id, {
        channelType: "system",
        channelId: "agents",
        routedBy: ROUTER_ID,
      });
      this.messages.markResolved(message.id, ROUTER_ID);
      return {
        messageId: message.id,
        ack:
          command.type === "pause"
            ? `已暂停 @${agent.config.name}。`
            : `已恢复 @${agent.config.name}。`,
        routedTo: { type: "system", id: "agents" },
        asyncWorkStarted: false,
      };
    } catch (err) {
      const action = command.type === "pause" ? "暂停" : "恢复";
      return this.routeSystemError(message, `${action} @${agent.config.name} 失败：${errorMessage(err)}`);
    }
  }

  private routeProjectCommand(
    message: TeamMessage,
    input: RouteHumanMessageInput,
    slug: string,
  ): RouteResult {
    try {
      const channel = this.ensureProjectChannel(slug);
      // /project 是绑定命令：后续同一外部 chat 的普通消息默认路由到该项目。
      this.projectChannels.bindExternalChat({
        externalChannel: input.externalChannel,
        externalChatId: input.externalChatId,
        channelType: "project",
        channelId: channel.id,
        createdBy: input.userId,
      });
      this.messages.routeMessage(message.id, {
        channelType: "project",
        channelId: channel.id,
        project: channel.slug,
        routedBy: ROUTER_ID,
      });
      this.messages.markResolved(message.id, ROUTER_ID);
      return {
        messageId: message.id,
        ack: `已将当前会话绑定到 #${channel.slug}。`,
        routedTo: { type: "project", id: channel.slug },
        asyncWorkStarted: false,
      };
    } catch (err) {
      return this.routeSystemError(message, `绑定项目失败：${errorMessage(err)}`);
    }
  }

  private routeStatusCommand(message: TeamMessage, target?: string): RouteResult {
    this.messages.routeMessage(message.id, {
      channelType: "system",
      channelId: "status",
      routedBy: ROUTER_ID,
    });
    this.messages.markResolved(message.id, ROUTER_ID);

    const ack = target ? this.statusForTarget(target) : this.overallStatus();
    return {
      messageId: message.id,
      ack,
      routedTo: { type: "system", id: "status" },
      asyncWorkStarted: false,
    };
  }

  private routeApprovalReply(
    message: TeamMessage,
    input: RouteHumanMessageInput,
    text: string,
  ): RouteResult | null {
    const approval = parseApprovalReply(text);
    if (!approval) return null;

    // 优先查当前外部 chat 绑定项目里的审批；没有绑定时退回全局第一个等待审批任务。
    const task = this.findAwaitingApproval(input);
    if (!task) return null;

    try {
      if (approval.action === "approve") {
        this.taskQueue.approveTask(task.id, approval.response || "Approved.", input.userId);
      } else {
        this.taskQueue.rejectTask(task.id, approval.response || "Rejected.", input.userId);
      }

      this.messages.routeMessage(message.id, {
        channelType: "coordinator",
        channelId: "tasks",
        project: task.project,
        taskId: task.id,
        routedBy: ROUTER_ID,
      });
      this.messages.markResolved(message.id, ROUTER_ID);
      return {
        messageId: message.id,
        ack: approval.action === "approve" ? `已批准任务 ${task.id}。` : `已拒绝任务 ${task.id}。`,
        routedTo: { type: "task", id: task.id },
        asyncWorkStarted: false,
      };
    } catch (err) {
      return this.routeSystemError(message, `处理审批回复失败：${errorMessage(err)}`);
    }
  }

  private parseAgentMention(text: string): ParsedMention | null {
    const match = text.match(/^@([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;

    const token = match[1];
    if (!token) return null;
    const agent = this.resolveAgent(token);
    if (!agent || !agent.config.direct_message) return null;
    return { agent, body: match[2]?.trim() ?? "" };
  }

  private parseProjectMention(text: string): ParsedProject | null {
    const match = text.match(/^#([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/);
    if (!match) return null;

    const slug = match[1];
    if (!slug) return null;
    const channel = this.ensureProjectChannel(slug);
    return { channel, body: match[2]?.trim() ?? "" };
  }

  private resolveAgent(token: string): RegisteredAgent | null {
    const normalized = normalizeToken(token);

    // 常规路径只匹配 active agent；后面的 fallback 用于 pause/resume 这类需要命中暂停 agent 的命令。
    const activeMatch = this.agentRegistry.listActive().find((agent) => agentMatches(agent, normalized));
    if (activeMatch) return activeMatch;

    try {
      const exact = this.agentRegistry.get(token);
      if (exact) return exact;
    } catch {}

    try {
      return this.agentRegistry.loadAll().find((agent) => agentMatches(agent, normalized)) ?? null;
    } catch {
      return null;
    }
  }

  private ensureProjectChannel(slug: string): ProjectChannel {
    return (
      this.projectChannels.getChannel(slug) ??
      this.projectChannels.createChannel({
        slug,
        title: titleFromSlug(slug),
      })
    );
  }

  private findAwaitingApproval(input: RouteHumanMessageInput): Task | null {
    const binding = this.projectChannels.resolveExternalChat(
      input.externalChannel,
      input.externalChatId,
    );
    if (binding?.channelType === "project") {
      const channel = this.projectChannels.getChannel(binding.channelId);
      const project = channel?.slug ?? binding.channelId;
      const projectTask = this.taskQueue.listTasks({
        status: "awaiting_approval",
        project,
        limit: 1,
      })[0];
      if (projectTask) return projectTask;
    }

    return this.taskQueue.listTasks({ status: "awaiting_approval", limit: 1 })[0] ?? null;
  }

  private routeSystemError(message: TeamMessage, ack: string): RouteResult {
    this.messages.routeMessage(message.id, {
      channelType: "system",
      channelId: "errors",
      routedBy: ROUTER_ID,
    });
    this.messages.markResolved(message.id, ROUTER_ID);
    return {
      messageId: message.id,
      ack,
      routedTo: { type: "system", id: "errors" },
      asyncWorkStarted: false,
    };
  }

  private statusForTarget(target: string): string {
    if (target.startsWith("@")) {
      const agent = this.resolveAgent(target.slice(1));
      if (!agent) return `没有找到 agent：${target.slice(1)}。`;
      const assigned = this.taskQueue.listTasks({ assignedTo: agent.config.name }).length;
      return `@${agent.config.name}: ${agent.config.status}/${agent.status}, tasks=${assigned}`;
    }

    if (target.startsWith("#")) {
      const slug = target.slice(1);
      const channel = this.projectChannels.getChannel(slug);
      if (!channel) return `没有找到项目频道：#${slug}。`;
      const pending = this.messages.getPendingForProject(channel.slug).length;
      const tasks = this.taskQueue.listTasks({ project: channel.slug }).length;
      return `#${channel.slug}: ${channel.status}, pending_messages=${pending}, tasks=${tasks}`;
    }

    return `无法识别 status 目标：${target}。`;
  }

  private overallStatus(): string {
    const activeAgents = this.agentRegistry.listActive().length;
    const projects = this.projectChannels.listChannels({ status: "active" }).length;
    const pendingTasks = this.taskQueue.listTasks({ status: "pending" }).length;
    const awaitingApproval = this.taskQueue.listTasks({ status: "awaiting_approval" }).length;
    return `team: active_agents=${activeAgents}, active_projects=${projects}, pending_tasks=${pendingTasks}, awaiting_approval=${awaitingApproval}`;
  }
}

function parseCommand(text: string): ParsedCommand | null {
  // 命令解析保持严格，避免普通聊天误触发有副作用的任务状态修改。
  const task = text.match(/^\/task\s+(\S+)\s+(approve|reject|cancel)(?:\s+([\s\S]*))?$/i);
  if (task) {
    return {
      type: "task",
      taskId: task[1]!,
      action: task[2]!.toLowerCase() as "approve" | "reject" | "cancel",
      response: task[3]?.trim() ?? "",
    };
  }

  const pause = text.match(/^\/(pause|resume)\s+@?([A-Za-z0-9_-]+)\s*$/i);
  if (pause) {
    return {
      type: pause[1]!.toLowerCase() as "pause" | "resume",
      agentToken: pause[2]!,
    };
  }

  const project = text.match(/^\/project\s+#?([a-z0-9][a-z0-9_-]*)\s*$/);
  if (project) {
    return { type: "project", slug: project[1]! };
  }

  const status = text.match(/^\/status(?:\s+(\S+))?\s*$/i);
  if (status) {
    return { type: "status", target: status[1] };
  }

  return null;
}

function parseApprovalReply(text: string): { action: "approve" | "reject"; response: string } | null {
  // 审批快捷回复只接受很短的确定性词，避免长消息被误判成审批。
  const approve = text.match(/^(approve|approved|yes|ok|同意|批准)(?:\s+([\s\S]*))?$/i);
  if (approve) return { action: "approve", response: approve[2]?.trim() ?? "" };

  const reject = text.match(/^(reject|rejected|no|否|拒绝)(?:\s+([\s\S]*))?$/i);
  if (reject) return { action: "reject", response: reject[2]?.trim() ?? "" };

  return null;
}

function routeTargetFromMessage(message: TeamMessage): RouteTarget {
  if (message.taskId) return { type: "task", id: message.taskId };
  if (message.channelType === "agent_dm") return { type: "agent", id: message.channelId };
  if (message.channelType === "project") return { type: "project", id: message.project ?? message.channelId };
  if (message.channelType === "system") return { type: "system", id: message.channelId };
  return { type: "coordinator", id: message.channelId };
}

function agentMatches(agent: RegisteredAgent, normalized: string): boolean {
  if (normalizeToken(agent.config.name) === normalized) return true;
  return agent.config.aliases.some((alias) => normalizeToken(alias) === normalized);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function taskCommandAck(command: Extract<ParsedCommand, { type: "task" }>): string {
  if (command.action === "approve") return `已批准任务 ${command.taskId}。`;
  if (command.action === "reject") return `已拒绝任务 ${command.taskId}。`;
  return `已取消任务 ${command.taskId}。`;
}

function taskCommandErrorAck(command: Extract<ParsedCommand, { type: "task" }>, err: unknown): string {
  const action = command.action === "approve" ? "批准" : command.action === "reject" ? "拒绝" : "取消";
  return `${action}任务 ${command.taskId} 失败：${errorMessage(err)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
