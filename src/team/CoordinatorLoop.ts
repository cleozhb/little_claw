import { createAgentConfig } from "../agents/AgentConfig.ts";
import { AgentLoop } from "../core/AgentLoop.ts";
import { EphemeralConversation } from "../core/EphemeralConversation.ts";
import type { ContextRetriever } from "../memory/ContextRetriever.ts";
import type { MemoryManager } from "../memory/MemoryManager.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { SkillManager } from "../skills/SkillManager.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { ShellTool } from "../tools/types.ts";
import { createLogger } from "../utils/logger.ts";
import type { AgentRegistry, RegisteredAgent } from "./AgentRegistry.ts";
import {
  COORDINATOR_TOOL_NAMES,
  type CoordinatorTaskDefaults,
  ensureCoordinatorTools,
  summarizeProjectChannel,
} from "./CoordinatorTools.ts";
import type { ProjectChannelStore } from "./ProjectChannelStore.ts";
import type { Task, TaskQueue } from "./TaskQueue.ts";
import type { TeamMessageStore, TeamMessage } from "./TeamMessageStore.ts";
import type { TeamScheduleStore } from "./TeamScheduleStore.ts";

const log = createLogger("CoordinatorLoop");
const DEFAULT_COORDINATOR_CHANNEL_ID = "default";

export interface CoordinatorLoopOptions {
  agents: AgentRegistry;
  tasks: TaskQueue;
  messages: TeamMessageStore;
  channels: ProjectChannelStore;
  schedules?: TeamScheduleStore;
  llmProvider: LLMProvider;
  toolRegistry: ToolRegistry;
  skillManager?: SkillManager;
  shellTool?: ShellTool;
  memoryManager?: MemoryManager;
  contextRetriever?: ContextRetriever;
  pollIntervalMs?: number;
  maxTurns?: number;
  projectSummaryThreshold?: number;
  coordinatorName?: string;
}

export type CoordinatorLoopState = "idle" | "running" | "stopped";

/**
 * Coordinator scheduler for Lovely Octopus team mode.
 *
 * 团队模式的调度中枢。核心职责：
 * 1. 定时轮询（每 2 秒），巡检任务和消息状态
 * 2. 确定性逻辑：超时检测、失败上报、任务分配（不需要 LLM）
 * 3. 需要决策时：启动临时 AgentLoop，让 coordinator 用 LLM 推理 + 调用 CoordinatorTools
 *
 * 设计思路：能确定性处理的绝不调 LLM（省成本），只有需要"判断"时才启动推理。
 */
export class CoordinatorLoop {
  private agents: AgentRegistry;
  private tasks: TaskQueue;
  private messages: TeamMessageStore;
  private channels: ProjectChannelStore;
  private schedules?: TeamScheduleStore;
  private llmProvider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private skillManager?: SkillManager;
  private shellTool?: ShellTool;
  private memoryManager?: MemoryManager;
  private contextRetriever?: ContextRetriever;
  private pollIntervalMs: number;
  private maxTurns: number;
  private projectSummaryThreshold: number;
  private coordinatorName: string;

  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private currentLoop: AgentLoop | null = null;
  private currentTaskDefaults: CoordinatorTaskDefaults | undefined;
  private stateValue: CoordinatorLoopState = "idle";

  constructor(options: CoordinatorLoopOptions) {
    this.agents = options.agents;
    this.tasks = options.tasks;
    this.messages = options.messages;
    this.channels = options.channels;
    this.schedules = options.schedules;
    this.llmProvider = options.llmProvider;
    this.toolRegistry = options.toolRegistry;
    this.skillManager = options.skillManager;
    this.shellTool = options.shellTool;
    this.memoryManager = options.memoryManager;
    this.contextRetriever = options.contextRetriever;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.maxTurns = options.maxTurns ?? 30;
    this.projectSummaryThreshold = options.projectSummaryThreshold ?? 10;
    this.coordinatorName = options.coordinatorName ?? "coordinator";

    ensureCoordinatorTools(this.toolRegistry, {
      tasks: this.tasks,
      messages: this.messages,
      channels: this.channels,
      agents: this.agents,
      schedules: this.schedules,
      llmProvider: this.llmProvider,
      getTaskDefaults: () => this.currentTaskDefaults,
    });
  }

  get state(): CoordinatorLoopState {
    return this.stateValue;
  }

  get isRunning(): boolean {
    return this.currentLoop?.isRunning ?? false;
  }

  /** 启动轮询循环，开始定时巡检 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.currentLoop?.abort();
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.stateValue = "stopped";
  }

  /**
   * 单次巡检：按顺序执行 5 个步骤。
   * 前 3 步是确定性逻辑（不需要 LLM），后 2 步可能触发 LLM 推理。
   */
  async tick(): Promise<void> {
    if (this.currentLoop?.isRunning) return;

    this.stateValue = "running";
    try {
      this.failTimedOutTasks();                          // ① 超时任务标记失败
      this.escalateFailedTasks();                        // ② 失败任务上报给 coordinator 频道
      this.assignPendingTasks();                         // ③ 按 tag 匹配，将 pending 任务分配给空闲 agent
      await this.summarizeBusyProjectChannels();         // ④ 消息过多的项目频道做摘要
      const handledCoordinatorInbox = await this.handleCoordinatorInbox();  // ⑤ 处理 coordinator 收件箱
      if (!handledCoordinatorInbox) {
        await this.handleProjectChannelInbox();          // ⑥ 处理项目频道中未处理的人类消息
      }
    } finally {
      this.stateValue = "idle";
    }
  }

  /** 轮询主循环：每隔 pollIntervalMs（默认 2 秒）执行一次 tick */
  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      if (!this.stopped) {
        await sleep(this.pollIntervalMs);
      }
    }
  }

  /** ③ 确定性任务分配：遍历所有空闲 agent，按 tag 匹配将 pending 任务分配出去 */
  private assignPendingTasks(): void {
    const agents = this.listAssignableAgents();
    for (const agent of agents) {
      const candidates = this.tasks.getPendingForAgent(agent);
      for (const task of candidates) {
        const latest = this.tasks.getTask(task.id);
        if (!latest || latest.status !== "pending") continue;
        if (latest.tags.length > 0 && !hasOverlap(latest.tags, agent.config.task_tags)) continue;
        log.step("Coordinator deterministically assigned pending task", {
          taskId: latest.id,
          agent: agent.config.name,
          tags: latest.tags,
        });
        this.tasks.assignTask(latest.id, agent.config.name);
      }
    }
  }

  /** ① 超时检测：running 状态超过 agent 配置的 timeout_minutes 的任务标记为 failed */
  private failTimedOutTasks(): void {
    const running = this.tasks.listTasks({ status: "running" });
    const now = Date.now();
    for (const task of running) {
      if (!task.startedAt || !task.assignedTo) continue;
      const agent = this.agents.get(task.assignedTo);
      const timeoutMinutes = agent?.config.timeout_minutes ?? 30;
      const startedAt = Date.parse(task.startedAt);
      if (!Number.isFinite(startedAt)) continue;
      const elapsedMs = now - startedAt;
      if (elapsedMs < timeoutMinutes * 60_000) continue;

      log.warn(
        `Coordinator detected timed out task ${task.id}`,
        `assignedTo=${task.assignedTo} elapsedMs=${elapsedMs}`,
      );
      this.tasks.failTask(
        task.id,
        `Task timed out after ${timeoutMinutes} minute(s).`,
        this.coordinatorName,
      );
    }
  }

  /** ② 失败上报：failed 状态的任务生成一条消息到 coordinator 频道，等待 LLM 介入处理 */
  private escalateFailedTasks(): void {
    for (const task of this.tasks.listTasks({ status: "failed" })) {
      if (this.hasCoordinatorEscalation(task.id)) continue;
      const content = `Task ${task.id} failed and needs coordinator attention.\nTitle: ${task.title}\nError: ${task.error ?? "(none)"}`;
      this.messages.createMessage({
        channelType: "coordinator",
        channelId: DEFAULT_COORDINATOR_CHANNEL_ID,
        taskId: task.id,
        senderType: "system",
        senderId: "task-queue",
        content,
        priority: "high",
      });
    }
  }

  /** ④ 频道摘要：项目频道消息超过阈值时，调 LLM 生成摘要并标记已处理 */
  private async summarizeBusyProjectChannels(): Promise<void> {
    for (const channel of this.channels.listChannels({ status: "active" })) {
      const pending = this.messages.getPendingForProject(channel.slug, this.projectSummaryThreshold);
      if (pending.length < this.projectSummaryThreshold) continue;
      if (pending.some((message) => message.senderId === this.coordinatorName)) continue;

      log.step("Coordinator summarizing busy project channel", {
        project: channel.slug,
        pendingMessages: pending.length,
      });
      await summarizeProjectChannel(
        {
          tasks: this.tasks,
          messages: this.messages,
          channels: this.channels,
          agents: this.agents,
          llmProvider: this.llmProvider,
        },
        {
          project: channel.slug,
          limit: this.projectSummaryThreshold,
          markResolved: true,
        },
      );
    }
  }

  /** ⑤ 处理 coordinator 收件箱：有需要协调决策的消息时，启动 LLM 推理 */
  private async handleCoordinatorInbox(): Promise<boolean> {
    const pendingMessages = this.messages.listMessages({
      channelType: "coordinator",
      channelId: DEFAULT_COORDINATOR_CHANNEL_ID,
      statuses: ["new", "routed", "acked"],
      limit: 20,
    }).filter((message) => message.senderId !== this.coordinatorName);
    if (pendingMessages.length === 0) return false;

    await this.runCoordinatorOnMessages(pendingMessages, this.resolveCoordinatorReplyTarget(pendingMessages));
    return true;
  }

  /**
   * ⑥ 处理项目频道中未处理的人类消息。
   * 快捷路径：项目只有唯一 owner agent 时，直接创建任务分配，跳过 LLM。
   * 否则启动 coordinator LLM 推理决定如何处理。
   */
  private async handleProjectChannelInbox(): Promise<boolean> {
    for (const channel of this.channels.listChannels({ status: "active" })) {
      if (this.hasWorkerOwnedProjectTask(channel.slug)) continue;

      const pendingMessages = this.messages
        .getPendingForProject(channel.slug, 20)
        .filter((message) => message.senderType === "human" && !message.taskId);
      if (pendingMessages.length === 0) continue;

      const owner = this.findSingleProjectOwner(channel.slug);
      if (owner) {
        this.createProjectOwnerTask(channel, owner, pendingMessages);
        return true;
      }

      log.step("Coordinator handling project channel inbox", {
        project: channel.slug,
        pendingMessages: pendingMessages.length,
      });
      await this.runCoordinatorOnMessages(pendingMessages, {
        replyChannelType: "project",
        replyChannelId: channel.id,
        project: channel.slug,
      });
      return true;
    }
    return false;
  }

  /**
   * 核心方法：启动一个临时 AgentLoop 让 coordinator 用 LLM 推理。
   * 流程：组装上下文 → 运行 ReAct 循环（可调用 CoordinatorTools）→ 把回复写入频道。
   */
  private async runCoordinatorOnMessages(
    pendingMessages: TeamMessage[],
    replyTarget: { replyChannelType: "coordinator"; replyChannelId: string } | {
      replyChannelType: "project";
      replyChannelId: string;
      project: string;
    },
  ): Promise<void> {
    const coordinator = this.requireCoordinatorAgent();
    const conversation = new EphemeralConversation("Lovely Octopus coordinator execution.");
    const loop = new AgentLoop(this.llmProvider, this.toolRegistry, conversation, {
      config: createAgentConfig({
        name: coordinator.config.name,
        systemPrompt: buildCoordinatorSystemPrompt(coordinator),
        allowedTools: uniqueStrings([
          ...coordinator.config.tools,
          ...COORDINATOR_TOOL_NAMES,
        ]),
        maxTurns: this.maxTurns,
        canSpawnSubAgent: false,
      }),
      skillManager: this.skillManager,
      configuredSkillNames: coordinator.config.skills,
      skillScopeNames: replyTarget.replyChannelType === "project"
        ? this.inferProjectSkillScope(replyTarget.project)
        : [],
      shellTool: this.shellTool,
      memoryManager: this.memoryManager,
      contextRetriever: this.contextRetriever,
      runMode: "coordinator",
      contextMode: replyTarget.replyChannelType === "project" ? "project" : "always",
      projectContextPath: replyTarget.replyChannelType === "project"
        ? `context-hub/3-projects/${replyTarget.project}`
        : undefined,
    });

    for (const message of pendingMessages) {
      this.messages.markInjected(message.id, this.coordinatorName);
    }

    this.currentLoop = loop;
    let assistantText = "";
    try {
      this.currentTaskDefaults = this.buildTaskDefaults(pendingMessages, replyTarget);
      for await (const event of loop.run(buildCoordinatorUserPrompt({
        messages: pendingMessages,
        tasks: this.tasks.listTasks({ limit: 20 }),
        agents: this.listActiveAgents(),
      }))) {
        if (event.type === "text_delta") {
          assistantText += event.text;
        }
      }
    } finally {
      this.currentTaskDefaults = undefined;
      this.currentLoop = null;
    }

    const reply = assistantText.trim();
    if (!reply) return;

    if (replyTarget.replyChannelType === "project") {
      this.messages.createMessage({
        channelType: "project",
        channelId: replyTarget.replyChannelId,
        project: replyTarget.project,
        senderType: "coordinator",
        senderId: this.coordinatorName,
        content: reply,
        status: "resolved",
        handledBy: this.coordinatorName,
      });
      return;
    }

    this.messages.createMessage({
      channelType: "coordinator",
      channelId: replyTarget.replyChannelId,
      senderType: "coordinator",
      senderId: this.coordinatorName,
      content: reply,
      status: "resolved",
      handledBy: this.coordinatorName,
    });
  }

  private requireCoordinatorAgent(): RegisteredAgent {
    const agent = this.agents.get(this.coordinatorName);
    if (!agent || agent.config.status !== "active") {
      throw new Error(`Active coordinator agent not found: ${this.coordinatorName}`);
    }
    return agent;
  }

  private listActiveAgents(): RegisteredAgent[] {
    const active = this.agents.listActive();
    if (active.length > 0) return active;
    return this.agents.loadAll().filter((agent) => agent.config.status === "active");
  }

  private listAssignableAgents(): RegisteredAgent[] {
    return this.listActiveAgents().filter((agent) => agent.config.name !== this.coordinatorName);
  }

  private hasCoordinatorEscalation(taskId: string): boolean {
    return this.messages
      .listMessages({
        channelType: "coordinator",
        channelId: DEFAULT_COORDINATOR_CHANNEL_ID,
        taskId,
        limit: 100,
      })
      .some((message) => message.senderId === "task-queue" || message.senderId === this.coordinatorName);
  }

  private hasWorkerOwnedProjectTask(project: string): boolean {
    return this.tasks
      .listTasks({ project })
      .some((task) =>
        task.assignedTo &&
        ["assigned", "running", "awaiting_approval"].includes(task.status)
      );
  }

  private resolveCoordinatorReplyTarget(
    pendingMessages: TeamMessage[],
  ): { replyChannelType: "coordinator"; replyChannelId: string } | {
    replyChannelType: "project";
    replyChannelId: string;
    project: string;
  } {
    const project = this.inferSingleProject(pendingMessages);
    if (project) {
      const channel = this.channels.getChannel(project);
      return {
        replyChannelType: "project",
        replyChannelId: channel?.id ?? project,
        project: channel?.slug ?? project,
      };
    }

    return {
      replyChannelType: "coordinator",
      replyChannelId: DEFAULT_COORDINATOR_CHANNEL_ID,
    };
  }

  private inferSingleProject(messages: TeamMessage[]): string | undefined {
    const projects = new Set<string>();
    for (const message of messages) {
      if (message.project) {
        projects.add(message.project);
      }
      if (message.taskId) {
        const task = this.tasks.getTask(message.taskId);
        if (task?.project) {
          projects.add(task.project);
        }
      }
    }
    return projects.size === 1 ? [...projects][0] : undefined;
  }

  private buildTaskDefaults(
    pendingMessages: TeamMessage[],
    replyTarget: { replyChannelType: "coordinator"; replyChannelId: string } | {
      replyChannelType: "project";
      replyChannelId: string;
      project: string;
    },
  ): CoordinatorTaskDefaults | undefined {
    if (replyTarget.replyChannelType !== "project") return undefined;

    const sourceMessages = pendingMessages.filter((message) =>
      message.senderType === "human" && message.project === replyTarget.project,
    );
    return {
      project: replyTarget.project,
      channelId: replyTarget.replyChannelId,
      sourceMessageId: sourceMessages.length === 1 ? sourceMessages[0]?.id : undefined,
    };
  }

  private inferProjectSkillScope(project: string): string[] {
    const normalizedProject = normalizeRoutingToken(project);
    const skills: string[] = [];

    for (const agent of this.listActiveAgents()) {
      if (agent.config.name === this.coordinatorName) continue;
      if (!agentOwnsProject(agent, normalizedProject)) continue;
      skills.push(...agent.config.skills);
    }

    return uniqueStrings(skills);
  }

  /**
   * 快捷路径优化：如果项目只有唯一一个负责的 agent，直接返回它。
   * 避免为确定性结果浪费 LLM 调用。
   */
  private findSingleProjectOwner(project: string): RegisteredAgent | null {
    const normalizedProject = normalizeRoutingToken(project);
    const owners = this.listAssignableAgents().filter((agent) =>
      agentOwnsProject(agent, normalizedProject),
    );
    return owners.length === 1 ? owners[0]! : null;
  }

  private createProjectOwnerTask(
    channel: { id: string; slug: string },
    owner: RegisteredAgent,
    pendingMessages: TeamMessage[],
  ): Task {
    const firstHumanMessage = pendingMessages.find((message) => message.senderType === "human");
    const title = firstHumanMessage
      ? titleFromMessage(firstHumanMessage.content)
      : `Handle #${channel.slug} project update`;

    log.step("Coordinator delegated project channel inbox to owning agent", {
      project: channel.slug,
      agent: owner.config.name,
      messageCount: pendingMessages.length,
    });

    return this.tasks.createTask({
      title,
      description:
        `Handle the pending human request(s) in #${channel.slug}.\n\n` +
        `Project workspace: context-hub/3-projects/${channel.slug}\n\n` +
        `Messages:\n${formatMessages(pendingMessages)}`,
      project: channel.slug,
      channelId: channel.id,
      sourceMessageId: pendingMessages.length === 1 ? pendingMessages[0]?.id : undefined,
      assignedTo: owner.config.name,
      createdBy: this.coordinatorName,
      priority: 0,
    });
  }
}

export function buildCoordinatorSystemPrompt(agent: RegisteredAgent): string {
  return `<agent_soul>
${agent.soul.trim()}
</agent_soul>

<agent_operating_instructions>
${agent.operatingInstructions.trim()}
</agent_operating_instructions>

<coordinator_boundaries>
You are a coordinator, not the human's boss and not the only team entrypoint.
Use CoordinatorTools for task and message facts. Do not bypass TaskQueue or TeamMessageStore.
For recurring reminders, periodic work, or a user asking to do something at a future time, use create_team_schedule/list_team_schedules/update_team_schedule when available. Do not ask a worker agent to create crontab, launchd, Reminders, or other OS-level schedulers.
Prefer deterministic assignment and status checks when they are enough.
When delegating executable work to agents, create_task, create_task_dag, or delegate_task must create durable TaskQueue records first.
Use create_task_dag instead of repeated create_task calls for any multi-step workflow with dependencies, so the DAG is created atomically.
send_message_to_agent is only for informal DM or existing-task follow-up, never for assigning new work.
</coordinator_boundaries>`;
}

export function buildCoordinatorUserPrompt(params: {
  messages: TeamMessage[];
  tasks: Task[];
  agents: RegisteredAgent[];
}): string {
  return `<coordinator_context>
pending_coordinator_messages:
${formatMessages(params.messages)}

recent_tasks:
${formatTasks(params.tasks)}

active_agents:
${formatAgents(params.agents)}
</coordinator_context>`;
}

function formatMessages(messages: TeamMessage[]): string {
  if (messages.length === 0) return "(none)";
  return messages
    .map((message) => {
      const project = message.project ? ` project=${message.project}` : "";
      const task = message.taskId ? ` task=${message.taskId}` : "";
      return `- ${message.id} [${message.channelType}:${message.channelId}${project}${task}] ${message.senderType}:${message.senderId}: ${message.content}`;
    })
    .join("\n");
}

function formatTasks(tasks: Task[]): string {
  if (tasks.length === 0) return "(none)";
  return tasks
    .map((task) => {
      const assigned = task.assignedTo ? ` assigned=${task.assignedTo}` : "";
      const tags = task.tags.length > 0 ? ` tags=${task.tags.join(",")}` : "";
      return `- ${task.id} status=${task.status}${assigned}${tags}: ${task.title}`;
    })
    .join("\n");
}

function formatAgents(agents: RegisteredAgent[]): string {
  if (agents.length === 0) return "(none)";
  return agents
    .map((agent) => `- ${agent.config.name}: tags=${agent.config.task_tags.join(",") || "(none)"}`)
    .join("\n");
}

function hasOverlap(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function uniqueStrings(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function agentOwnsProject(agent: RegisteredAgent, normalizedProject: string): boolean {
  const projectTokens = [
    agent.config.name,
    agent.config.default_project,
    ...agent.config.aliases,
    ...agent.config.cron_jobs.map((job) => job.project),
    ...(agent.config.watchers ?? []).map((watcher) => watcher.project),
  ];
  return projectTokens.some((token) => token && normalizeRoutingToken(token) === normalizedProject);
}

function normalizeRoutingToken(value: string): string {
  return value.trim().toLowerCase().replace(/^[@#]/, "");
}

function titleFromMessage(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "Handle project request";
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
