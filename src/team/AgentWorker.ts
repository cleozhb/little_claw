import { createAgentConfig } from "../agents/AgentConfig.ts";
import { AgentLoop } from "../core/AgentLoop.ts";
import { EphemeralConversation } from "../core/EphemeralConversation.ts";
import type { ContextRetriever } from "../memory/ContextRetriever.ts";
import type { ContextHub } from "../memory/ContextHub.ts";
import type { MemoryManager } from "../memory/MemoryManager.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { SkillManager } from "../skills/SkillManager.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { ShellTool, Tool } from "../tools/types.ts";
import type { AgentEvent } from "../types/message.ts";
import type { RegisteredAgent } from "./AgentRegistry.ts";
import type { Task } from "./TaskQueue.ts";
import { TaskQueue } from "./TaskQueue.ts";
import type { ProjectChannelStore } from "./ProjectChannelStore.ts";
import { TeamMessageStore, type TeamMessage } from "./TeamMessageStore.ts";
import { createLogger } from "../utils/logger.ts";

export const REPORT_PROGRESS_TOOL = "report_progress";
export const REQUEST_APPROVAL_TOOL = "request_approval";

const log = createLogger("AgentWorker");

export interface AgentWorkerOptions {
  agent: RegisteredAgent;
  tasks: TaskQueue;
  messages: TeamMessageStore;
  projectChannels?: ProjectChannelStore;
  llmProvider: LLMProvider;
  toolRegistry: ToolRegistry;
  skillManager?: SkillManager;
  shellTool?: ShellTool;
  memoryManager?: MemoryManager;
  contextRetriever?: ContextRetriever;
  contextHub?: ContextHub;
  pollIntervalMs?: number;
  maxTurns?: number;
}

export type AgentWorkerState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "paused"
  | "stopped";

/**
 * 单个常驻 Agent 的运行时适配器。
 *
 * AgentWorker 只负责调度、查询任务/消息、组装上下文；真正的 LLM 流式响应、
 * 工具调用和工具结果回填都交给现有 AgentLoop，避免 Team 模式长出第二套执行循环。
 */
export class AgentWorker {
  private agent: RegisteredAgent;
  private tasks: TaskQueue;
  private messages: TeamMessageStore;
  private projectChannels?: ProjectChannelStore;
  private llmProvider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private skillManager?: SkillManager;
  private shellTool?: ShellTool;
  private memoryManager?: MemoryManager;
  private contextRetriever?: ContextRetriever;
  private contextHub?: ContextHub;
  private pollIntervalMs: number;
  private maxTurns: number;

  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private currentLoop: AgentLoop | null = null;
  private currentTaskId: string | null = null;
  private taskConversations = new Map<string, EphemeralConversation>();
  private stateValue: AgentWorkerState = "idle";

  constructor(options: AgentWorkerOptions) {
    this.agent = options.agent;
    this.tasks = options.tasks;
    this.messages = options.messages;
    this.projectChannels = options.projectChannels;
    this.llmProvider = options.llmProvider;
    this.toolRegistry = options.toolRegistry;
    this.skillManager = options.skillManager;
    this.shellTool = options.shellTool;
    this.memoryManager = options.memoryManager;
    this.contextRetriever = options.contextRetriever;
    this.contextHub = options.contextHub;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.maxTurns = options.maxTurns ?? 10;

    ensureTeamTaskTools(this.toolRegistry, this.tasks);
    log.info(
      `已初始化 AgentWorker：${this.agent.config.name}`,
      `轮询间隔: ${this.pollIntervalMs}ms\n最大轮次: ${this.maxTurns}\n允许工具: ${this.agent.config.tools.join(", ") || "(none)"}`,
    );
  }

  get state(): AgentWorkerState {
    return this.stateValue;
  }

  get isRunning(): boolean {
    return this.currentLoop?.isRunning ?? false;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    log.step("启动 AgentWorker 后台循环", {
      agent: this.agent.config.name,
      pollIntervalMs: this.pollIntervalMs,
    });
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    log.step("停止 AgentWorker", {
      agent: this.agent.config.name,
      currentTaskId: this.currentTaskId ?? "(none)",
      hasRunningLoop: Boolean(this.currentLoop?.isRunning),
    });
    this.stopped = true;
    this.stopMessageMonitor();
    this.currentLoop?.abort();
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.stateValue = "stopped";
  }

  /**
   * 执行一次调度循环。
   *
   * 测试和后续 server.ts 生命周期接入可以直接调用 tick()；start() 只是定时重复 tick()。
   */
  async tick(): Promise<void> {
    // agent.yaml 的 status 是运行准入开关；暂停的 Agent 不领取任务，也不处理 DM。
    if (this.agent.config.status !== "active") {
      if (this.stateValue !== "paused") {
        log.info(`Agent 已暂停，跳过本轮调度：${this.agent.config.name}`);
      }
      this.stateValue = "paused";
      return;
    }

    if (this.currentLoop?.isRunning) {
      // 运行中的 AgentLoop 不被强行重启；只在 checkpoint 通过 inject() 补充人类新消息。
      log.debug(`Agent 正在运行，检查是否有可注入的人类消息：${this.agent.config.name}`);
      await this.injectPendingMessages();
      return;
    }

    // 控制消息优先级最高，避免 cancel/pause 被普通任务执行阻塞。
    if (this.handleControlMessages()) {
      log.info(`已处理控制消息，跳过本轮普通调度：${this.agent.config.name}`);
      return;
    }

    const task = this.nextTaskForAgent();
    if (task) {
      log.step("本轮调度选择任务", {
        agent: this.agent.config.name,
        taskId: task.id,
        status: task.status,
        title: task.title,
      });
      await this.runTask(task);
      return;
    }

    const directMessages = this.pendingDirectMessages();
    if (directMessages.length > 0) {
      log.step("本轮调度处理 Agent DM", {
        agent: this.agent.config.name,
        messageCount: directMessages.length,
      });
      await this.runDirectMessages(directMessages);
      return;
    }

    this.stateValue = "idle";
  }

  abortCurrent(reason = "Cancelled by human."): void {
    // 中断只通过 AgentLoop.abort() 进入底层执行；Worker 不直接取消 LLM/tool 实现细节。
    const taskId = this.currentTaskId;
    log.warn(
      `收到中断请求：${this.agent.config.name}`,
      `taskId: ${taskId ?? "(none)"}\n原因: ${reason}`,
    );
    this.currentLoop?.abort();
    if (taskId) {
      const task = this.tasks.getTask(taskId);
      if (task && isCancellable(task.status)) {
        log.info(`取消当前任务：${taskId}`, `原状态: ${task.status}`);
        this.tasks.cancelTask(taskId, reason, this.agent.config.name);
      }
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      if (!this.stopped) {
        await sleep(this.pollIntervalMs);
      }
    }
  }

  private nextTaskForAgent(): Task | null {
    const agentName = this.agent.config.name;
    // 先恢复已经分配或审批后待继续的任务，再领取新的 pending 任务。
    const assignedOrResumable = this.tasks
      .listTasks({ assignedTo: agentName })
      .find((task) => task.status === "approved" || task.status === "rejected" || task.status === "assigned");

    if (assignedOrResumable) {
      log.info(
        `发现已分配或待恢复任务：${assignedOrResumable.id}`,
        `agent: ${agentName}\n状态: ${assignedOrResumable.status}`,
      );
      return assignedOrResumable;
    }

    const [pending] = this.tasks.getPendingForAgent(this.agent, 1);
    if (!pending) return null;
    log.step("领取 pending 任务", {
      agent: agentName,
      taskId: pending.id,
      title: pending.title,
      tags: pending.tags,
    });
    return this.tasks.assignTask(pending.id, agentName);
  }

  private async runTask(task: Task): Promise<Task> {
    const agentName = this.agent.config.name;
    // startTask 会把 approved/rejected 改成 running，因此要先记住恢复来源。
    const approvalResumeStatus = getApprovalResumeStatus(task);
    log.step("启动任务执行", {
      agent: agentName,
      taskId: task.id,
      inputStatus: task.status,
      approvalResumeStatus: approvalResumeStatus ?? "(none)",
    });
    const running = this.tasks.startTask(task.id, agentName);
    this.currentTaskId = running.id;
    this.stateValue = "running";

    // 每个任务复用一段临时 Conversation；审批恢复时能保留审批前的工具调用上下文。
    const conversation = this.getTaskConversation(running.id);
    const loop = new AgentLoop(this.llmProvider, this.toolRegistry, conversation, {
      config: createAgentConfig({
        name: agentName,
        systemPrompt: buildTeamAgentSystemPrompt(this.agent),
        // 普通工具由 agent.yaml.tools 控制，团队任务工具由 Worker 显式补入。
        allowedTools: uniqueStrings([
          ...this.agent.config.tools,
          REPORT_PROGRESS_TOOL,
          REQUEST_APPROVAL_TOOL,
        ]),
        maxTurns: this.maxTurns,
        canSpawnSubAgent: false,
      }),
      skillManager: this.skillManager,
      shellTool: this.shellTool,
      memoryManager: this.memoryManager,
      contextRetriever: this.contextRetriever,
      channelId: task.channelId,
    });

    this.currentLoop = loop;

    // 人类消息必须先从 team_messages 取出并标记 injected，防止重启或重试时重复注入。
    const initialMessages = this.collectInjectableMessages(running);
    log.info(
      `任务初始上下文消息收集完成：${running.id}`,
      `messageCount: ${initialMessages.length}`,
    );
    for (const message of initialMessages) {
      log.debug(`标记初始消息已注入：${message.id}`, `handledBy: ${agentName}`);
      this.messages.markInjected(message.id, agentName);
    }

    // 审批恢复使用独立 user_update，让 Agent 明确知道人类是批准还是拒绝。
    const prompt = approvalResumeStatus
      ? buildTaskResumePrompt(running, initialMessages, approvalResumeStatus)
      : buildTaskUserPrompt(running, initialMessages, this.getSourceMessage(running));

    let assistantText = "";
    let errorMessage: string | null = null;
    // 任务运行期间后台检查新消息；真正注入仍由 AgentLoop 在 checkpoint 消费。
    this.startMessageMonitor();

    try {
      for await (const event of loop.run(prompt)) {
        const action = this.handleAgentEvent(event);
        if (event.type === "text_delta") {
          assistantText += event.text;
        } else if (event.type === "error") {
          log.warn(`AgentLoop 返回错误：${running.id}`, event.message);
          errorMessage = event.message;
        }
        if (action === "approval_requested") {
          log.info(`任务请求审批，暂停当前 AgentLoop：${running.id}`);
          this.currentLoop?.abort();
        }
      }
    } finally {
      this.stopMessageMonitor();
      this.currentLoop = null;
      this.currentTaskId = null;
    }

    const latest = this.tasks.getTask(running.id);
    if (!latest) {
      throw new Error(`Task disappeared during worker run: ${running.id}`);
    }

    if (latest.status === "awaiting_approval") {
      // request_approval 工具已经把任务落库为 awaiting_approval；Worker 不完成任务，只停在审批态。
      log.step("任务进入等待审批", {
        agent: agentName,
        taskId: latest.id,
        approvalPrompt: latest.approvalPrompt ?? "(none)",
      });
      this.stateValue = "waiting_approval";
      return latest;
    }
    if (latest.status === "cancelled") {
      log.info(`任务已取消，清理临时对话：${latest.id}`);
      this.taskConversations.delete(latest.id);
      this.stateValue = "idle";
      return latest;
    }
    if (latest.status !== "running") {
      log.info(
        `任务状态已由外部改为 ${latest.status}，Worker 不再收尾：${latest.id}`,
        `agent: ${agentName}`,
      );
      this.stateValue = "idle";
      return latest;
    }
    if (errorMessage) {
      log.warn(`任务执行失败，交给 TaskQueue 处理重试：${latest.id}`, errorMessage);
      const failed = this.tasks.failTask(latest.id, errorMessage, agentName);
      if (failed.status === "pending") {
        // 可重试：重新分配给自己并发通知
        const retry = this.tasks.assignTask(failed.id, agentName);
        this.postTaskNotification(
          retry,
          `Task hit an execution error and has been scheduled for retry by @${agentName}.\n\nError: ${errorMessage}`,
        );
      } else {
        this.postTaskNotification(failed, `❌ Failed: ${errorMessage}`);
        await this.archiveTaskTerminalState(failed, "failed", errorMessage);
      }
      this.stateValue = "idle";
      return this.tasks.getTask(latest.id)!;
    }

    const completed = this.tasks.completeTask(latest.id, assistantText, agentName);
    log.step("任务执行完成", {
      agent: agentName,
      taskId: completed.id,
      resultLength: assistantText.length,
    });
    const trimmedResult = assistantText.trim() || "Task completed.";
    this.postTaskNotification(completed, trimmedResult);
    await this.archiveTaskTerminalState(completed, "completed", trimmedResult);
    this.taskConversations.delete(completed.id);
    this.stateValue = "idle";
    return completed;
  }

  private async runDirectMessages(directMessages: TeamMessage[]): Promise<void> {
    const agentName = this.agent.config.name;
    log.step("开始处理 Agent DM", {
      agent: agentName,
      messageCount: directMessages.length,
    });
    const conversation = new EphemeralConversation("Lovely Octopus agent direct message.");
    // Agent DM 没有关联任务，因此不注入 report_progress/request_approval 两个任务工具。
    // DM 消息可能来自不同频道，取第一条消息的 channelId 做记忆隔离
    const dmChannelId = directMessages[0]?.channelId;
    const loop = new AgentLoop(this.llmProvider, this.toolRegistry, conversation, {
      config: createAgentConfig({
        name: agentName,
        systemPrompt: buildTeamAgentSystemPrompt(this.agent),
        allowedTools: this.agent.config.tools,
        maxTurns: this.maxTurns,
        canSpawnSubAgent: false,
      }),
      skillManager: this.skillManager,
      shellTool: this.shellTool,
      memoryManager: this.memoryManager,
      contextRetriever: this.contextRetriever,
      channelId: dmChannelId,
    });

    for (const message of directMessages) {
      log.debug(`标记 DM 消息已注入：${message.id}`, `handledBy: ${agentName}`);
      this.messages.markInjected(message.id, agentName);
    }

    this.currentLoop = loop;
    this.stateValue = "running";
    let assistantText = "";
    try {
      for await (const event of loop.run(buildDirectMessagePrompt(directMessages))) {
        if (event.type === "text_delta") assistantText += event.text;
      }
    } finally {
      this.currentLoop = null;
      this.stateValue = "idle";
      log.info(`Agent DM 处理完成：${agentName}`);
    }
    // 将回复写入 agent_dm channel
    const reply = assistantText.trim();
    if (reply.length > 0) {
      this.messages.createMessage({
        channelType: "agent_dm",
        channelId: agentName,
        senderType: "agent",
        senderId: agentName,
        content: reply,
        status: "resolved",
        handledBy: agentName,
      });
    }
  }

  /** 任务终态归档：将结果追加到项目的 context-hub status.md */
  private async archiveTaskTerminalState(
    task: Task,
    status: "completed" | "failed",
    content: string,
  ): Promise<void> {
    if (!this.contextHub || !task.project) return;
    try {
      await this.contextHub.writeFile(
        `3-projects/${task.project}/status.md`,
        formatTaskArchiveEntry(task, status, this.agent.config.name, content),
        "append",
      );
    } catch (err) {
      log.warn(
        `任务结果写入项目 status.md 失败：${task.id}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** 任务完成/失败时，往 project channel 发完整结果，同时往 agent DM 发简短通知 */
  private postTaskNotification(task: Task, content: string): void {
    const agentName = this.agent.config.name;
    if (!content) return;

    if (task.project) {
      // 完整结果发到 project channel
      this.postProjectTaskNotification(task, content, agentName);
      // 简短通知发到 agent DM，让用户在 agent 视图也能看到任务活动
      const statusIcon = task.status === "completed" ? "✅" : "❌";
      this.messages.createMessage({
        channelType: "agent_dm",
        channelId: agentName,
        project: task.project,
        taskId: task.id,
        senderType: "agent",
        senderId: agentName,
        content: `${statusIcon} ${task.status === "completed" ? "Completed" : "Failed"} "${task.title}" in #${task.project}`,
        status: "resolved",
        handledBy: agentName,
      });
      return;
    }

    // 无 project 的任务回到该任务所属 Agent 的 DM；如果来源是其它 agent_dm，则沿用来源 DM。
    const source = task.sourceMessageId ? this.messages.getMessage(task.sourceMessageId) : null;
    this.messages.createMessage({
      channelType: "agent_dm",
      channelId: source?.channelType === "agent_dm" ? source.channelId : agentName,
      taskId: task.id,
      senderType: "agent",
      senderId: agentName,
      content,
      status: "resolved",
      handledBy: agentName,
    });
  }

  private postProjectTaskNotification(task: Task, content: string, agentName: string): void {
    if (!task.project) return;
    if (this.projectChannels) {
      try {
        this.ensureProjectChannel(task.project);
        this.projectChannels.postMessage(task.project, {
          taskId: task.id,
          senderType: "agent",
          senderId: agentName,
          content,
          status: "resolved",
          handledBy: agentName,
        });
        return;
      } catch (err) {
        log.warn(
          `项目频道回写失败，回退到 TeamMessageStore：${task.id}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    this.messages.createMessage({
      channelType: "project",
      channelId: task.channelId ?? task.project,
      project: task.project,
      taskId: task.id,
      senderType: "agent",
      senderId: agentName,
      content,
      status: "resolved",
      handledBy: agentName,
    });
  }

  private ensureProjectChannel(project: string): void {
    if (!this.projectChannels || this.projectChannels.getChannel(project)) return;
    this.projectChannels.createChannel({
      slug: project,
      title: titleFromSlug(project),
    });
  }

  private handleAgentEvent(event: AgentEvent): "approval_requested" | "none" {
    // 审批工具是暂停信号：工具执行仍由 AgentLoop 完成，Worker 只观察工具结果并中止后续轮次。
    if (
      event.type === "tool_result" &&
      event.name === REQUEST_APPROVAL_TOOL &&
      event.result.success
    ) {
      log.info(`检测到 request_approval 工具成功返回，准备暂停任务`);
      return "approval_requested";
    }
    return "none";
  }

  private startMessageMonitor(): void {
    this.stopMessageMonitor();
    log.debug(`启动运行中消息注入监视器：${this.agent.config.name}`);
    this.monitorTimer = setInterval(() => {
      this.injectPendingMessages().catch(() => {
        // 注入轮询失败不能拖垮正在执行的 AgentLoop；下一轮 tick 仍会继续尝试。
      });
    }, this.pollIntervalMs);
  }

  private stopMessageMonitor(): void {
    if (!this.monitorTimer) return;
    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    log.debug(`停止运行中消息注入监视器：${this.agent.config.name}`);
  }

  private async injectPendingMessages(): Promise<void> {
    if (!this.currentLoop?.isRunning || !this.currentTaskId) return;

    // 运行中也优先处理 cancel/pause，普通补充消息走 inject()。
    if (this.handleControlMessages()) return;

    const task = this.tasks.getTask(this.currentTaskId);
    if (!task) return;

    const messages = this.collectInjectableMessages(task);
    if (messages.length === 0) return;

    log.step("向运行中的 AgentLoop 注入人类补充消息", {
      agent: this.agent.config.name,
      taskId: task.id,
      messageCount: messages.length,
      messageIds: messages.map((message) => message.id),
    });
    // inject() 只入 AgentLoop 队列，具体生效点由 AgentLoop 在工具结果或 end_turn checkpoint 处理。
    this.currentLoop.inject(formatInjectedUpdate(messages));
    for (const message of messages) {
      this.messages.markInjected(message.id, this.agent.config.name);
    }
  }

  private collectInjectableMessages(task: Task): TeamMessage[] {
    // 任务上下文同时吸收 Agent DM、项目频道和 task_id 直连消息，并去重防止同一消息重复出现。
    return uniqueMessages([
      ...this.messages.getPendingForAgent(this.agent.config.name),
      ...(task.project ? this.messages.getPendingForProject(task.project) : []),
      ...this.messages.getPendingForTask(task.id),
    ]).filter((message) => !isControlMessage(message));
  }

  private pendingDirectMessages(): TeamMessage[] {
    return this.messages
      .getPendingForAgent(this.agent.config.name)
      .filter((message) => !isControlMessage(message));
  }

  private handleControlMessages(): boolean {
    let handled = false;
    for (const message of this.messages.getPendingForAgent(this.agent.config.name)) {
      // 控制消息仍然来自 team_messages，处理后标记 resolved，避免再次生效。
      const command = parseControlCommand(message.content);
      if (!command) continue;

      handled = true;
      log.step("处理 Agent 控制消息", {
        agent: this.agent.config.name,
        command,
        messageId: message.id,
      });
      if (command === "cancel") {
        this.abortCurrent(message.content);
      } else if (command === "pause") {
        this.currentLoop?.abort();
        this.stateValue = "paused";
      }
      this.messages.markResolved(message.id, this.agent.config.name);
    }
    return handled;
  }

  private getSourceMessage(task: Task): TeamMessage | undefined {
    if (!task.sourceMessageId) return undefined;
    return this.messages.getMessage(task.sourceMessageId) ?? undefined;
  }

  private getTaskConversation(taskId: string): EphemeralConversation {
    let conversation = this.taskConversations.get(taskId);
    if (!conversation) {
      // Conversation 只是一次执行窗口；长期事实仍以 TaskQueue 和 TeamMessageStore 为准。
      log.debug(`为任务创建新的临时对话：${taskId}`);
      conversation = new EphemeralConversation("Lovely Octopus team task execution.");
      this.taskConversations.set(taskId, conversation);
    }
    return conversation;
  }
}

export function createAgentWorkers(
  agents: RegisteredAgent[],
  options: Omit<AgentWorkerOptions, "agent">,
): AgentWorker[] {
  return agents
    .filter((agent) => agent.config.status === "active")
    .map((agent) => new AgentWorker({ ...options, agent }));
}

export function buildTeamAgentSystemPrompt(agent: RegisteredAgent): string {
  // 三文件模型在 system prompt 里明确分块，避免人格和操作流程混在一起。
  return `<agent_soul>
${agent.soul.trim()}
</agent_soul>

<agent_operating_instructions>
${agent.operatingInstructions.trim()}
</agent_operating_instructions>`;
}

export function buildTaskUserPrompt(task: Task, teamMessages: TeamMessage[], sourceMessage?: TeamMessage): string {
  // 任务描述和近期团队消息放在 user prompt，便于 AgentLoop 保持原有 system prompt 机制。
  const sourceSection = sourceMessage
    ? `\nsource_message:\n- [${sourceMessage.channelType}:${sourceMessage.channelId}] ${sourceMessage.senderId}: ${sourceMessage.content}\n`
    : "";
  return `<task_context>
id: ${task.id}
title: ${task.title}
description: ${task.description}
project: ${task.project ?? "none"}
project_workspace: ${task.project ? `context-hub/3-projects/${task.project}` : "none"}
workspace_instruction: ${task.project ? `Create and edit project files under context-hub/3-projects/${task.project}/ unless the task explicitly names another path.` : "No project workspace is attached to this task."}
approval_response: ${task.approvalResponse ?? "none"}${sourceSection}
recent_team_messages:
${formatTeamMessages(teamMessages)}
</task_context>`;
}

export function buildTaskResumePrompt(
  task: Task,
  teamMessages: TeamMessage[],
  decision: "approved" | "rejected" = task.status === "approved" ? "approved" : "rejected",
): string {
  return `${buildTaskUserPrompt(task, teamMessages)}

<user_update>
Human approval status: ${decision}
Human response: ${task.approvalResponse ?? "(none)"}
Continue the task from this updated instruction. If the request was rejected, revise the plan or cancel safely.
</user_update>`;
}

export function buildDirectMessagePrompt(teamMessages: TeamMessage[]): string {
  return `<direct_message_context>
recent_agent_dm_messages:
${formatTeamMessages(teamMessages)}
</direct_message_context>`;
}

function ensureTeamTaskTools(toolRegistry: ToolRegistry, tasks: TaskQueue): void {
  // 复用外部传入的 ToolRegistry，只补充 Team 模式需要的任务工具。
  if (!toolRegistry.get(REPORT_PROGRESS_TOOL)) {
    log.info(`注册团队任务工具：${REPORT_PROGRESS_TOOL}`);
    toolRegistry.register(reportProgressTool(tasks));
  }
  if (!toolRegistry.get(REQUEST_APPROVAL_TOOL)) {
    log.info(`注册团队任务工具：${REQUEST_APPROVAL_TOOL}`);
    toolRegistry.register(requestApprovalTool(tasks));
  }
}

function reportProgressTool(tasks: TaskQueue): Tool {
  return {
    name: REPORT_PROGRESS_TOOL,
    description: "Append a progress update to a Lovely Octopus team task log.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The current team task id." },
        content: { type: "string", description: "Progress update to record." },
      },
      required: ["task_id", "content"],
    },
    async execute(params) {
      const taskId = readToolString(params, "task_id");
      const content = readToolString(params, "content");
      log.info(`记录任务进度：${taskId}`, content);
      tasks.addProgress(taskId, content);
      return { success: true, output: "Progress recorded." };
    },
  };
}

function requestApprovalTool(tasks: TaskQueue): Tool {
  return {
    name: REQUEST_APPROVAL_TOOL,
    description: "Pause a Lovely Octopus team task and request human approval before continuing.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The current team task id." },
        prompt: { type: "string", description: "The approval question for the human." },
        data: { type: "object", description: "Optional structured data for the approval request." },
      },
      required: ["task_id", "prompt"],
    },
    async execute(params) {
      const taskId = readToolString(params, "task_id");
      const prompt = readToolString(params, "prompt");
      log.step("工具请求人类审批", {
        taskId,
        prompt,
        hasData: params.data !== undefined,
      });
      tasks.requestApproval(taskId, {
        prompt,
        data: params.data,
      });
      return { success: true, output: "Approval requested; task paused." };
    },
  };
}

function readToolString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function formatInjectedUpdate(messages: TeamMessage[]): string {
  return `Human messages received while you were working:
${formatTeamMessages(messages)}`;
}

function formatTeamMessages(messages: TeamMessage[]): string {
  if (messages.length === 0) return "(none)";
  return messages
    .map((message) => {
      const task = message.taskId ? ` task=${message.taskId}` : "";
      const project = message.project ? ` project=${message.project}` : "";
      return `- [${message.channelType}:${message.channelId}${project}${task}] ${message.senderId}: ${message.content}`;
    })
    .join("\n");
}

function uniqueMessages(items: TeamMessage[]): TeamMessage[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
}

function getApprovalResumeStatus(task: Task): "approved" | "rejected" | null {
  if (task.status === "approved" || task.status === "rejected") return task.status;
  return null;
}

function isControlMessage(message: TeamMessage): boolean {
  return parseControlCommand(message.content) !== null;
}

function parseControlCommand(content: string): "cancel" | "pause" | null {
  const normalized = content.trim().toLowerCase();
  if (normalized.startsWith("/cancel") || normalized.startsWith("cancel")) return "cancel";
  if (normalized.startsWith("/pause") || normalized.startsWith("pause")) return "pause";
  return null;
}

function isCancellable(status: Task["status"]): boolean {
  return ["pending", "assigned", "running", "awaiting_approval", "approved", "rejected"].includes(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTaskArchiveEntry(
  task: Task,
  status: "completed" | "failed",
  agentName: string,
  content: string,
): string {
  const timestamp = new Date().toISOString();
  return `

## Task ${status === "completed" ? "Completed" : "Failed"}: ${task.title}

- id: ${task.id}
- status: ${status}
- agent: ${agentName}
- completed_at: ${timestamp}
- retry_count: ${task.retryCount}/${task.maxRetries}

### Result

${content}`;
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
