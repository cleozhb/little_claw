import { createAgentConfig } from "../agents/AgentConfig.ts";
import { AgentLoop } from "../core/AgentLoop.ts";
import { Conversation } from "../core/Conversation.ts";
import { EphemeralConversation } from "../core/EphemeralConversation.ts";
import type { ConversationLike } from "../core/ConversationLike.ts";
import {
  normalizeProjectContextPath,
  projectWorkspaceRoot,
  scopeProjectWriteFileInput,
} from "../core/ProjectWorkspace.ts";
import type { Database } from "../db/Database.ts";
import type { ContextRetriever } from "../memory/ContextRetriever.ts";
import type { ContextHub } from "../memory/ContextHub.ts";
import type { MemoryManager } from "../memory/MemoryManager.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { SkillManager } from "../skills/SkillManager.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { ShellTool, Tool } from "../tools/types.ts";
import type { AgentEvent, ToolUseBlock } from "../types/message.ts";
import type { ApprovalRule } from "./ApprovalGate.ts";
import type { RegisteredAgent } from "./AgentRegistry.ts";
import type { Task } from "./TaskQueue.ts";
import { TaskQueue } from "./TaskQueue.ts";
import type { ProjectChannelStore } from "./ProjectChannelStore.ts";
import { TeamMessageStore, type TeamMessage } from "./TeamMessageStore.ts";
import { createLogger } from "../utils/logger.ts";

export const REPORT_PROGRESS_TOOL = "report_progress";
export const REQUEST_APPROVAL_TOOL = "request_approval";

const log = createLogger("AgentWorker");
type AgentEventAction = "approval_requested" | "stop" | "none";
const RATE_LIMIT_RETRY_BASE_MS = 5 * 60 * 1000;
const RATE_LIMIT_RETRY_MAX_MS = 30 * 60 * 1000;
const TEAM_OS_SCHEDULER_APPROVAL_RULE: ApprovalRule = {
  tool: "shell",
  pattern:
    "(^|[\\s;&|])(?:crontab|launchctl)(?:\\s|$)|(^|[\\s;&|])at\\s|osascript.*(?:display notification|Reminders|Calendar)|LaunchAgents",
  message:
    "团队任务不应直接创建或测试操作系统级定时/提醒；请改用内部 TeamScheduleStore。确需系统集成时需要人类审批。",
};

export type TaskProgressCallback = (taskId: string, agentName: string, delta: string) => void;

export interface AgentWorkerOptions {
  agent: RegisteredAgent;
  tasks: TaskQueue;
  messages: TeamMessageStore;
  projectChannels?: ProjectChannelStore;
  db?: Database;
  llmProvider: LLMProvider;
  toolRegistry: ToolRegistry;
  skillManager?: SkillManager;
  shellTool?: ShellTool;
  memoryManager?: MemoryManager;
  contextRetriever?: ContextRetriever;
  contextHub?: ContextHub;
  pollIntervalMs?: number;
  maxTurns?: number;
  onTaskProgress?: TaskProgressCallback;
}

export type AgentWorkerState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "paused"
  | "stopped";

/**
 * 单个常驻 Agent 的运行时适配器（"员工"角色）。
 *
 * 核心职责：
 * 1. 每 1 秒轮询一次，检查有没有活干（任务 > DM > 空闲）
 * 2. 拿到任务后启动 AgentLoop 执行（ReAct 循环）
 * 3. 运行期间持续监听新消息，通过 inject 机制插入 AgentLoop
 * 4. 执行完毕后更新任务状态（完成/失败/等待审批），并通知项目频道
 *
 * 只负责调度、查询任务和消息、组装上下文；不直接操作 LLM/工具，全部委托给 AgentLoop，避免 Team 模式长出第二套执行循环。
 */
export class AgentWorker {
  private agent: RegisteredAgent;
  private tasks: TaskQueue;
  private messages: TeamMessageStore;
  private projectChannels?: ProjectChannelStore;
  private db?: Database;
  private llmProvider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private skillManager?: SkillManager;
  private shellTool?: ShellTool;
  private memoryManager?: MemoryManager;
  private contextRetriever?: ContextRetriever;
  private contextHub?: ContextHub;
  private pollIntervalMs: number;
  private maxTurns: number;
  private onTaskProgress?: TaskProgressCallback;

  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private currentLoop: AgentLoop | null = null;
  private currentTaskId: string | null = null;
  private currentSessionId: string | null = null;
  private stateValue: AgentWorkerState = "idle";

  constructor(options: AgentWorkerOptions) {
    this.agent = options.agent;
    this.tasks = options.tasks;
    this.messages = options.messages;
    this.projectChannels = options.projectChannels;
    this.db = options.db;
    this.llmProvider = options.llmProvider;
    this.toolRegistry = options.toolRegistry;
    this.skillManager = options.skillManager;
    this.shellTool = options.shellTool;
    this.memoryManager = options.memoryManager;
    this.contextRetriever = options.contextRetriever;
    this.contextHub = options.contextHub;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.maxTurns = options.maxTurns ?? this.agent.config.max_turns ?? 10;
    this.onTaskProgress = options.onTaskProgress;

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

  /** 启动后台轮询循环 */
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
   * 单次调度：决定这一轮干什么。
   * 测试和后续 server.ts 生命周期接入可以直接调用 tick()；start() 只是定时重复 tick()。
   * 优先级：控制消息(cancel/pause) > 任务 > DM > 空闲
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

    // 正在干活 → 只检查有没有新消息可以注入
    if (this.currentLoop?.isRunning) {
      // 运行中的 AgentLoop 不被强行重启；只在 checkpoint 通过 inject() 补充人类新消息。
      log.debug(`Agent 正在运行，检查是否有可注入的人类消息：${this.agent.config.name}`);
      await this.injectPendingMessages();
      return;
    }

    // 控制消息（cancel/pause）优先级最高
    if (this.handleControlMessages()) {
      log.info(`已处理控制消息，跳过本轮普通调度：${this.agent.config.name}`);
      return;
    }

    // 有分配给我的任务 → 去干活
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

    // 没有任务，但有人给我发私信 → 回复 DM
    const directMessages = this.pendingDirectMessages();
    if (directMessages.length > 0) {
      log.step("本轮调度处理 Agent DM", {
        agent: this.agent.config.name,
        messageCount: directMessages.length,
      });
      await this.runDirectMessages(directMessages);
      return;
    }

    // 什么都没有 → 空闲
    this.stateValue = "idle";
  }

  /** 外部中断：abort AgentLoop + 取消当前任务 */
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

  /** 轮询主循环：每隔 pollIntervalMs（默认 1 秒）执行一次 tick */
  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      if (!this.stopped) {
        await sleep(this.pollIntervalMs);
      }
    }
  }

  /**
   * 查找下一个要执行的任务。
   * 优先级：恢复审批后的任务(approved/rejected) > 已分配的(assigned) > 领取新的(pending)
   */
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

  /**
   * 核心方法：执行一个任务的完整生命周期。
   * 流程：
   * 
    1. tasks.startTask()
      assigned/approved/rejected -> running

    2. getTaskConversation()
      创建或恢复这个 task 对应的 Conversation

    3. getTaskLoop()
      用 agent 配置创建 core AgentLoop

    4. collectInjectableMessages()
      把 DM、project、task 相关消息作为上下文，并 markInjected

    5. loop.run(prompt)
      真正让模型推理和调用工具

    6. 收尾时重新读 latest task
      因为执行过程中任务状态可能被工具或外部命令改了.这里是重点关注的地方，它中间执行 loop 时，任务状态也可能被 request_approval 工具、approval gate、cancel 控制消息等改掉，因此收尾前必须重新读数据库。JavaScript 是单线程事件循环，但 await 期间其他异步任务会运行；数据库状态也可能已经变了。因此 runTask() 跑完 loop 后不能直接说“我刚才开始的是 running，那我现在就 completeTask”
      几个典型来源：
        - Agent 自己通过工具改状态，AgentLoop 里模型可能调用 request_approval
        - Approval gate 改状态，如果 Agent 准备调用一个需要审批的工具，AgentLoop 会发出 approval_gate_triggered 事件
        - 用户中途插话，发 cancel/pause，worker 运行时有一个 message monitor，会定时看 agent DM 里有没有控制消息，如果发现 cancel，会调用：
          abortCurrent()
            -> currentLoop.abort()
            -> tasks.cancelTask(...)
        - 其他入口也能改任务状态 /task <id> cancel

    7. 根据 latest 状态收尾，这次 runTask 不再收尾，后续是否继续由状态机决定
      awaiting_approval -> 保持等待审批
      cancelled -> 不做事
      error -> failTask()
      正常 -> completeTask()


    最典型的审批流程是：
    running
      -> request_approval / approval_gate
      -> awaiting_approval
      -> runTask 返回，不 complete

    用户 approve
      -> approved

    下一次 worker.tick()
      -> nextTaskForAgent() 找到 approved
      -> startTask() 把 approved 改 running
      -> runTask 继续      
   */
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

    // 每个任务复用一段持久化 Conversation；审批恢复时能从 DB 完整重建对话上下文。
    const conversation = this.getTaskConversation(running.id);
    this.currentSessionId = conversation.getSessionId();

    // --- Approved: 直接执行被拦截的工具调用，跳过 LLM ---
    let directExecuted = false;
    if (approvalResumeStatus === "approved") {
      const directResult = await this.directExecuteApprovedTool(running, conversation);
      if (directResult) {
        directExecuted = true;
        if (this.onTaskProgress) {
          this.onTaskProgress(running.id, agentName, `已执行：${directResult.toolName}\n${directResult.output.slice(0, 200)}`);
        }
      }
    }

    const loop = this.getTaskLoop(running.id, conversation, running.project, task.channelId);

    this.currentLoop = loop;

    // 从 DB 恢复所有已批准的调用（进程重启后也能重建），防止再次触发 gate
    if (this.db && this.currentSessionId) {
      const approvedKeys = this.db.getApprovedCallKeys(this.currentSessionId);
      for (const key of approvedKeys) {
        loop.approveCallKey(key);
      }
    }

    // 审批恢复：将已批准的具体调用写入 approvedCalls，防止 LLM 重新生成同一命令时再次触发 gate
    if (approvalResumeStatus === "approved") {
      const data = running.approvalData as { tool?: string; params?: Record<string, unknown> } | undefined;
      if (data?.tool) {
        loop.approveToolCall(data.tool, data.params);
      }
      // 将 session_approvals 中的 pending 记录标记为 approved
      if (this.db && this.currentSessionId) {
        const pending = this.db.getSessionPendingApproval(this.currentSessionId);
        if (pending) {
          this.db.approveSessionApproval(pending.id);
        }
      }
    } else if (approvalResumeStatus === "rejected") {
      // 将 session_approvals 中的 pending 记录标记为 rejected
      if (this.db && this.currentSessionId) {
        const pending = this.db.getSessionPendingApproval(this.currentSessionId);
        if (pending) {
          this.db.rejectSessionApproval(pending.id);
        }
      }
    }

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

    // 构建 prompt
    let prompt: string;
    if (approvalResumeStatus === "approved" && directExecuted) {
      // 工具已直接执行并写入 conversation，只需让 LLM 继续后续步骤
      prompt = "已批准的工具调用已经执行。请继续完成任务，所有可见输出使用中文。";
    } else if (approvalResumeStatus) {
      // 软审批(无 approvalData.tool) 或直接执行失败，走 LLM resume
      prompt = buildTaskResumePrompt(running, initialMessages, approvalResumeStatus);
    } else {
      prompt = buildTaskUserPrompt(running, initialMessages, this.getSourceMessage(running));
    }

    let assistantText = "";
    let errorMessage: string | null = null;
    // 任务运行期间后台检查新消息；真正注入仍由 AgentLoop 在 checkpoint 消费。
    this.startMessageMonitor();

    // Throttled progress emission: batch deltas and flush every 100ms
    let pendingDelta = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushProgress = () => {
      if (pendingDelta && this.onTaskProgress) {
        this.onTaskProgress(running.id, agentName, pendingDelta);
        pendingDelta = "";
      }
      flushTimer = null;
    };

    try {
      for await (const event of loop.run(prompt)) {
        const action = this.handleAgentEvent(event);
        if (event.type === "text_delta") {
          assistantText += event.text;
          if (this.onTaskProgress) {
            pendingDelta += event.text;
            if (!flushTimer) {
              flushTimer = setTimeout(flushProgress, 100);
            }
          }
        } else if (event.type === "error") {
          log.warn(`AgentLoop 返回错误：${running.id}`, event.message);
          errorMessage = event.message;
        }
        if (action === "approval_requested" || action === "stop") {
          log.info(`任务事件要求暂停当前 AgentLoop：${running.id}`, `action: ${action}`);
          this.currentLoop?.abort();
        }
      }
    } finally {
      // Flush any remaining delta
      if (flushTimer) clearTimeout(flushTimer);
      flushProgress();
      this.stopMessageMonitor();
      this.currentLoop = null;
      this.currentTaskId = null;
      this.currentSessionId = null;
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
      // 向 agent DM channel 发送审批通知，让 Agent Thread 中也能看到并操作审批
      const data = latest.approvalData as { tool?: string; params?: Record<string, unknown> } | undefined;
      let content = `🔒 **需要审批** — "${latest.title}"\n\n${latest.approvalPrompt ?? "此任务需要人类审批后才能继续。"}`;
      if (data?.tool) {
        const paramsStr = data.params ? JSON.stringify(data.params, null, 2) : "";
        content += `\n\n**工具：** \`${data.tool}\``;
        if (paramsStr) content += `\n\`\`\`json\n${paramsStr}\n\`\`\``;
      }
      this.messages.createMessage({
        channelType: "agent_dm",
        channelId: agentName,
        project: latest.project ?? undefined,
        taskId: latest.id,
        senderType: "system",
        senderId: "approval-gate",
        content,
        priority: "urgent",
        status: "new",
      });
      this.stateValue = "waiting_approval";
      return latest;
    }
    if (latest.status === "cancelled") {
      log.info(`任务已取消：${latest.id}`);
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
      const retryDelayMs = retryDelayForError(errorMessage, latest.retryCount);
      const failed = this.tasks.failTask(latest.id, errorMessage, agentName, { retryDelayMs });
      if (failed.status === "pending") {
        if (failed.dueAt) {
          this.postTaskNotification(
            failed,
            `任务执行触发限流，已延迟到 ${failed.dueAt} 后由 @${agentName} 重试。\n\n错误：${errorMessage}`,
          );
          this.stateValue = "idle";
          return failed;
        }
        // 可立即重试：重新分配给自己并发通知
        const retry = this.tasks.assignTask(failed.id, agentName);
        this.postTaskNotification(
          retry,
          `任务执行出错，已安排 @${agentName} 重试。\n\n错误：${errorMessage}`,
        );
      } else {
        this.postTaskNotification(failed, `❌ 失败：${errorMessage}`);
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
    const trimmedResult = assistantText.trim() || "任务已完成。";
    this.postTaskNotification(completed, trimmedResult);
    await this.archiveTaskTerminalState(completed, "completed", trimmedResult);
    this.stateValue = "idle";
    return completed;
  }

  /** 处理私信：没有任务关联，不注入任务工具，回复写入 agent_dm 频道 */
  /** 
   * DM模式使用EphemeralConversation，这是纯内存的。
   * 它默认不创建 TaskQueue 任务，所以没有 durable task 状态、重试、审批恢复、项目结果归档这些东西。

   * 想聊天/问一下 -> @agent
   * 想让团队正式处理并留下状态 -> #project 或 coordinator
   * 想审批/取消已有任务 -> /task <id> approve|reject|cancel
  */
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
        approvalRules: teamWorkerApprovalRules(this.agent.config.approval_rules),
        maxTurns: this.maxTurns,
        canSpawnSubAgent: false,
      }),
      skillManager: this.skillManager,
      configuredSkillNames: this.agent.config.skills,
      shellTool: this.shellTool,
      memoryManager: this.memoryManager,
      contextRetriever: this.contextRetriever,
      channelId: dmChannelId,
      runMode: "agent_dm",
      contextMode: "auto",
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
      const replyProject = sharedProject(directMessages);
      this.messages.createMessage({
        channelType: "agent_dm",
        channelId: agentName,
        project: replyProject,
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
      const statusText = task.status === "completed" ? "已完成" : "失败";
      this.messages.createMessage({
        channelType: "agent_dm",
        channelId: agentName,
        project: task.project,
        taskId: task.id,
        senderType: "agent",
        senderId: agentName,
        content: `${statusIcon} ${statusText}「${task.title}」(#${task.project})`,
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

  private handleAgentEvent(event: AgentEvent): AgentEventAction {
    // 审批工具是暂停信号：工具执行仍由 AgentLoop 完成，Worker 只观察工具结果并中止后续轮次。
    if (
      event.type === "tool_result" &&
      event.name === REQUEST_APPROVAL_TOOL &&
      event.result.success
    ) {
      log.info(`检测到 request_approval 工具成功返回，准备暂停任务`);
      return "approval_requested";
    }
    // 硬审批 gate 触发
    if (event.type === "approval_gate_triggered") {
      const taskId = this.currentTaskId;
      if (!taskId) {
        log.warn(`忽略 approval gate：当前没有运行中的任务`, `tool: ${event.toolName}`);
        return "stop";
      }
      const task = this.tasks.getTask(taskId);
      if (!task) {
        log.warn(`忽略 approval gate：任务不存在`, `taskId: ${taskId}\ntool: ${event.toolName}`);
        return "stop";
      }
      if (task.status !== "running") {
        log.warn(
          `忽略 approval gate：任务状态已不是 running`,
          `taskId: ${task.id}\nstatus: ${task.status}\ntool: ${event.toolName}`,
        );
        return "stop";
      }
      const rule = event.rule as { message?: string; pattern?: string } | undefined;
      this.tasks.requestApproval(task.id, {
        prompt: rule?.message ?? `Agent 尝试调用需要审批的工具 "${event.toolName}"。`,
        data: { tool: event.toolName, params: event.params, rule },
      });
      // 持久化到 session_approvals 表，进程重启后可恢复 approvedCalls
      if (this.db && this.currentSessionId) {
        this.db.createSessionApproval(this.currentSessionId, {
          toolName: event.toolName,
          params: (event.params ?? {}) as Record<string, unknown>,
          rule,
          message: rule?.message ?? `Agent 尝试调用需要审批的工具 "${event.toolName}"。`,
        });
      }
      return "approval_requested";
    }
    return "none";
  }

  /** 任务运行期间启动定时器，每秒检查新消息并 inject 到 AgentLoop */
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

  /** 运行中注入：收集新的人类消息，通过 AgentLoop.inject() 塞进去 */
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

  /** 从三个来源收集可注入的消息：Agent DM + 项目频道 + 任务直连，去重后返回 */
  private collectInjectableMessages(task: Task): TeamMessage[] {
    // 任务上下文同时吸收 Agent DM、项目频道和 task_id 直连消息，并去重防止同一消息重复出现。
    // system 消息是面向人类的通知（如审批卡片），不注入给 Agent。
    return uniqueMessages([
      ...this.messages.getPendingForAgent(this.agent.config.name),
      ...(task.project ? this.messages.getPendingForProject(task.project) : []),
      ...this.messages.getPendingForTask(task.id),
    ]).filter((message) => !isControlMessage(message) && message.senderType !== "system");
  }

  private pendingDirectMessages(): TeamMessage[] {
    return this.messages
      .getPendingForAgent(this.agent.config.name)
      .filter((message) => !isControlMessage(message) && message.senderType !== "system");
  }

  /** 处理控制消息：识别 "cancel"/"pause" 命令，执行中断或暂停 */
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

  private getTaskConversation(taskId: string): ConversationLike {
    const task = this.tasks.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // If we have a DB, use persistent Conversation bound to this task's session
    if (this.db) {
      if (task.sessionId) {
        log.debug(`从 DB 恢复任务对话：${taskId}, sessionId=${task.sessionId}`);
        return Conversation.loadExisting(this.db, task.sessionId);
      }
      const systemPrompt = buildTeamAgentSystemPrompt(this.agent);
      const conversation = Conversation.createNew(this.db, systemPrompt, "team_task");
      this.tasks.setSessionId(taskId, conversation.getSessionId());
      log.debug(`为任务创建持久化对话：${taskId}, sessionId=${conversation.getSessionId()}`);
      return conversation;
    }

    // Fallback: ephemeral (no DB provided, e.g. in tests)
    log.debug(`为任务创建临时对话（无 DB）：${taskId}`);
    return new EphemeralConversation("Lovely Octopus team task execution.");
  }

  private getTaskLoop(_taskId: string, conversation: ConversationLike, project?: string, channelId?: string): AgentLoop {
    const agentName = this.agent.config.name;
    const loop = new AgentLoop(this.llmProvider, this.toolRegistry, conversation, {
      config: createAgentConfig({
        name: agentName,
        systemPrompt: buildTeamAgentSystemPrompt(this.agent),
        allowedTools: uniqueStrings([
          ...this.agent.config.tools,
          REPORT_PROGRESS_TOOL,
          REQUEST_APPROVAL_TOOL,
        ]),
        approvalRules: teamWorkerApprovalRules(this.agent.config.approval_rules),
        maxTurns: this.maxTurns,
        canSpawnSubAgent: false,
      }),
      skillManager: this.skillManager,
      configuredSkillNames: this.agent.config.skills,
      shellTool: this.shellTool,
      memoryManager: this.memoryManager,
      contextRetriever: this.contextRetriever,
      channelId,
      runMode: "team_worker",
      contextMode: project ? "project" : this.agent.config.context_mode ?? "auto",
      projectContextPath: project ? `context-hub/3-projects/${project}` : undefined,
    });
    return loop;
  }

  /**
   * 审批通过后直接执行被拦截的工具调用，跳过 LLM。
   * 从 task.approvalData 取出 tool/params，执行后替换 conversation 中的 [APPROVAL REQUIRED] 结果。
   */
  private async directExecuteApprovedTool(
    task: Task,
    conversation: ConversationLike,
  ): Promise<{ toolName: string; output: string } | null> {
    const data = task.approvalData as { tool?: string; params?: Record<string, unknown> } | undefined;
    if (!data?.tool) return null;

    const tool = this.toolRegistry.get(data.tool);
    if (!tool) {
      log.warn(`审批恢复：工具 "${data.tool}" 未注册，将回退到 LLM 流程`);
      return null;
    }

    // 从 conversation 中找到对应的 tool_use_id
    const messages = conversation.getMessages();
    let toolUseId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.name === data.tool) {
          toolUseId = (block as ToolUseBlock).id;
          break;
        }
      }
      if (toolUseId) break;
    }

    log.step("审批通过，直接执行工具", {
      agent: this.agent.config.name,
      tool: data.tool,
      toolUseId: toolUseId ?? "(not found)",
    });

    try {
      const preparedParams = this.prepareDirectToolParams(data.tool, data.params ?? {}, task);
      if (!preparedParams.ok) {
        if (toolUseId) {
          conversation.replaceLastToolResult?.(toolUseId, preparedParams.error, true);
        }
        return { toolName: data.tool, output: preparedParams.error };
      }

      const result = await tool.execute(
        preparedParams.input,
        this.buildDirectToolExecuteOptions(data.tool, task),
      );
      const output = result.success ? result.output : (result.error ?? "Tool execution failed");

      // 替换 conversation 中的 [APPROVAL REQUIRED] 假结果
      if (toolUseId) {
        conversation.replaceLastToolResult?.(toolUseId, output, !result.success);
      }

      return { toolName: data.tool, output };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`审批恢复直接执行失败：${data.tool}`, errMsg);
      if (toolUseId) {
        conversation.replaceLastToolResult?.(toolUseId, `Execution error: ${errMsg}`, true);
      }
      return { toolName: data.tool, output: errMsg };
    }
  }

  private prepareDirectToolParams(
    toolName: string,
    params: Record<string, unknown>,
    task: Task,
  ): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
    if (toolName !== "write_file" || !task.project) {
      return { ok: true, input: params };
    }
    const scoped = scopeProjectWriteFileInput(params, `context-hub/3-projects/${task.project}`);
    if (!scoped.ok) return scoped;
    return { ok: true, input: scoped.input };
  }

  private buildDirectToolExecuteOptions(
    toolName: string,
    task: Task,
  ): { cwd?: string; env?: Record<string, string> } | undefined {
    if (toolName !== "shell" || !task.project) return undefined;
    const projectContextPath = normalizeProjectContextPath(`context-hub/3-projects/${task.project}`);
    const cwd = projectWorkspaceRoot(
      this.memoryManager?.getFileMemory()?.getBaseDir(),
      projectContextPath ?? undefined,
    );
    if (!cwd || !projectContextPath) return undefined;
    return {
      cwd,
      env: {
        LITTLE_CLAW_PROJECT_WORKSPACE: cwd,
        LITTLE_CLAW_PROJECT_CONTEXT_PATH: projectContextPath,
      },
    };
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
  const executionDate = formatTaskExecutionDate(task.createdAt);
  const promptBody = `<task_context>
id: ${task.id}
title: ${task.title}
description: ${task.description}
created_at: ${task.createdAt}
execution_date: ${executionDate}
retry_count: ${task.retryCount}
max_retries: ${task.maxRetries}
project: ${task.project ?? "none"}
project_workspace: ${task.project ? `context-hub/3-projects/${task.project}` : "none"}
workspace_instruction: ${task.project ? `Create and edit project files under context-hub/3-projects/${task.project}/ unless the task explicitly names another path.` : "No project workspace is attached to this task."}
approval_response: ${task.approvalResponse ?? "none"}${sourceSection}
recent_team_messages:
${formatTeamMessages(teamMessages)}
</task_context>`;

  return `<channel_output_rules>
除非任务明确要求其他语言，所有用户可见的任务进度、任务结果、项目频道消息和 Agent 私信都必须使用中文。过程说明保持简洁，不要把英文计划句写入频道可见输出。
</channel_output_rules>

<team_scheduling_boundary>
如果任务涉及每天、定期、未来某个时间提醒或周期性运行，优先依赖 Lovely Octopus 内部 TeamScheduleStore，由 coordinator 使用 create_team_schedule 创建。当前 worker 不应使用 shell、crontab、launchd、Reminders、Calendar 或其他操作系统级调度来实现提醒；如果内部调度工具不可用，请用中文说明需要 coordinator 创建内部定时任务，而不是自行绕过。
</team_scheduling_boundary>

${promptBody}`;
}

function formatTaskExecutionDate(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return createdAt.slice(0, 10);
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

export function buildTaskResumePrompt(
  task: Task,
  teamMessages: TeamMessage[],
  decision: "approved" | "rejected" = task.status === "approved" ? "approved" : "rejected",
): string {
  return `${buildTaskUserPrompt(task, teamMessages)}

<user_update>
人类审批决定：**${decision === "approved" ? "已批准" : "已拒绝"}**
人类回复：${task.approvalResponse ?? "无"}
${decision === "approved"
    ? "此前被阻止的工具调用已获批准。请直接继续执行，不要输出英文分析或复述审批过程。"
    : "请求已被拒绝。请用中文调整方案，或在无法安全继续时取消任务。"}
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

function teamWorkerApprovalRules(agentRules: ApprovalRule[] | undefined): ApprovalRule[] {
  return [TEAM_OS_SCHEDULER_APPROVAL_RULE, ...(agentRules ?? [])];
}

function reportProgressTool(tasks: TaskQueue): Tool {
  return {
    name: REPORT_PROGRESS_TOOL,
    description: "Append a progress update to a Lovely Octopus team task log. Use Chinese for human-visible content unless explicitly requested otherwise.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The current team task id." },
        content: { type: "string", description: "Progress update to record, preferably in Chinese." },
      },
      required: ["task_id", "content"],
    },
    async execute(params) {
      const taskId = readToolString(params, "task_id");
      const content = readToolString(params, "content");
      log.info(`记录任务进度：${taskId}`, content);
      tasks.addProgress(taskId, content);
      return { success: true, output: "进度已记录。" };
    },
  };
}

function requestApprovalTool(tasks: TaskQueue): Tool {
  return {
    name: REQUEST_APPROVAL_TOOL,
    description: "Pause a Lovely Octopus team task and request human approval before continuing. Write the approval prompt in Chinese unless explicitly requested otherwise.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The current team task id." },
        prompt: { type: "string", description: "The approval question for the human, preferably in Chinese." },
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
      return { success: true, output: "已请求审批，任务已暂停。" };
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
  return `你工作期间收到的人类补充消息：
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

function sharedProject(messages: TeamMessage[]): string | undefined {
  const projects = [...new Set(messages.map((message) => message.project).filter(Boolean))] as string[];
  return projects.length === 1 ? projects[0] : undefined;
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

function retryDelayForError(message: string, retryCountBeforeFailure: number): number | undefined {
  if (!isRateLimitError(message)) return undefined;
  const retryAfterMs = parseRetryAfterMs(message);
  if (retryAfterMs !== undefined) return retryAfterMs;
  const attempt = Math.max(0, retryCountBeforeFailure);
  return Math.min(RATE_LIMIT_RETRY_BASE_MS * 2 ** attempt, RATE_LIMIT_RETRY_MAX_MS);
}

function isRateLimitError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("too many requests") ||
    /\btpm\b/.test(text) ||
    text.includes("tokens per min")
  );
}

function parseRetryAfterMs(message: string): number | undefined {
  const secondsMatch = message.match(/(?:try again in|retry after)\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i);
  if (secondsMatch?.[1]) return Math.ceil(Number(secondsMatch[1]) * 1000);

  const minutesMatch = message.match(/(?:try again in|retry after)\s+(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?/i);
  if (minutesMatch?.[1]) return Math.ceil(Number(minutesMatch[1]) * 60 * 1000);

  return undefined;
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
