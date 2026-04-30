import type { Server, ServerWebSocket } from "bun";
import { Database } from "../db/Database";
import { ToolRegistry } from "../tools/ToolRegistry";
import type { LLMProvider } from "../llm/types.ts";
import {
  parseClientMessage,
  serializeServerMessage,
  type ClientMessage,
  type ServerMessage,
  type SessionInfo,
  type MessageSummary,
  type HealthTargetInfo,
  type SkillInfo,
  type CronJobInfo,
  type WatcherInfo,
  type AgentInfo,
  type MemoryResultEntry,
  type TeamMessageInfo,
  type ProjectChannelInfo,
  type TaskInfo,
  type TeamMessagePriority,
} from "./protocol";
import { HealthChecker, type HealthStatus } from "./HealthChecker.ts";
import { LLMHealthTarget } from "./health/LLMHealthTarget.ts";
import { WebSocketHealthTarget } from "./health/WebSocketHealthTarget.ts";
import { ClientConnectionHealthTarget } from "./health/ClientConnectionHealthTarget.ts";
import type { SkillManager } from "../skills/SkillManager.ts";
import type { McpManager } from "../mcp/McpManager.ts";
import type { CronScheduler } from "../scheduler/CronScheduler.ts";
import type { EventWatcher } from "../scheduler/EventWatcher.ts";
import type { MemoryManager } from "../memory/MemoryManager.ts";
import type { ContextRetriever } from "../memory/ContextRetriever.ts";
import type { ContextIndexer } from "../memory/ContextIndexer.ts";
import type { ContextMetaGenerator } from "../memory/ContextMetaGenerator.ts";
import type { SimulationManager } from "../simulation/SimulationManager.ts";
import { getAllAgentConfigs } from "../agents/presets.ts";
import type { FeishuAdapter } from "./adapters/FeishuAdapter.ts";
import type { TeamRouter } from "../team/TeamRouter.ts";
import type { TeamMessageStore, TeamMessage } from "../team/TeamMessageStore.ts";
import type { ProjectChannelStore, ProjectChannel } from "../team/ProjectChannelStore.ts";
import type { TaskQueue, Task } from "../team/TaskQueue.ts";
import type { WebhookMessage } from "./adapters/types.ts";

// ============================================================
// Types
// ============================================================

export interface GatewayOptions {
  port?: number;
  hostname?: string;
  db: Database;
  toolRegistry: ToolRegistry;
  /** LLM Provider，用于健康检查 */
  llmProvider: LLMProvider;
  /** SkillManager，用于 list_skills */
  skillManager?: SkillManager;
  /** McpManager，用于 MCP server 管理 */
  mcpManager?: McpManager;
  /** Scheduler 实例，用于 list_cron / list_watchers */
  cronScheduler?: CronScheduler;
  eventWatcher?: EventWatcher;
  /** MemoryManager，用于 memory_search */
  memoryManager?: MemoryManager;
  /** ContextRetriever，用于 /context search */
  contextRetriever?: ContextRetriever;
  /** ContextIndexer，用于 /context rebuild */
  contextIndexer?: ContextIndexer;
  /** ContextMetaGenerator，用于 /context rebuild */
  contextMetaGenerator?: ContextMetaGenerator;
  /** SimulationManager，用于 simulation 相关命令 */
  simulationManager?: SimulationManager;
  /** 飞书适配器，启用后接收 POST /webhook/feishu */
  feishuAdapter?: FeishuAdapter;
  /** Lovely Octopus 团队模式路由器 */
  teamRouter?: TeamRouter;
  /** Lovely Octopus 团队消息存储 */
  teamMessages?: TeamMessageStore;
  /** Lovely Octopus 项目频道存储 */
  projectChannels?: ProjectChannelStore;
  /** Lovely Octopus 任务队列 */
  taskQueue?: TaskQueue;
  /** session 切换时的回调（用于触发旧 session 的记忆保存） */
  onSessionSwitch?: (oldSessionId: string, newSessionId: string) => void;
  /** chat 消息的处理回调，由外部（如 SessionRouter）注入 */
  onChat?: (connectionId: string, sessionId: string, content: string) => void;
  /** webhook chat 的处理回调，收集完整回复后回调 */
  onWebhookChat?: (sessionId: string, content: string) => Promise<string>;
  /** abort 消息的处理回调 */
  onAbort?: (sessionId: string) => boolean;
  /** inject 消息的处理回调 */
  onInject?: (sessionId: string, content: string) => boolean;
  /** 获取活跃 session 数的回调 */
  getActiveSessionCount?: () => number;
}

interface ConnectionData {
  connectionId: string;
}

// ============================================================
// GatewayServer
// ============================================================

export class GatewayServer {
  private server: Server<ConnectionData> | null = null;
  private connections = new Map<string, ServerWebSocket<ConnectionData>>();
  private db: Database;
  private toolRegistry: ToolRegistry;
  private onChat?: GatewayOptions["onChat"];
  private onWebhookChat?: GatewayOptions["onWebhookChat"];
  private onAbort?: GatewayOptions["onAbort"];
  private onInject?: GatewayOptions["onInject"];
  private getActiveSessionCount?: GatewayOptions["getActiveSessionCount"];
  private skillManager?: SkillManager;
  private mcpManager?: McpManager;
  private cronScheduler?: CronScheduler;
  private eventWatcher?: EventWatcher;
  private memoryManager?: MemoryManager;
  private contextRetriever?: ContextRetriever;
  private contextIndexer?: ContextIndexer;
  private contextMetaGenerator?: ContextMetaGenerator;
  private simulationManager?: SimulationManager;
  private feishuAdapter?: FeishuAdapter;
  private teamRouter?: TeamRouter;
  private teamMessages?: TeamMessageStore;
  private projectChannels?: ProjectChannelStore;
  private taskQueue?: TaskQueue;
  private onSessionSwitch?: (oldSessionId: string, newSessionId: string) => void;
  private port: number;
  private hostname: string;

  // 健康监控
  private healthChecker: HealthChecker;
  private wsHealthTarget: WebSocketHealthTarget;
  private clientTargets = new Map<string, ClientConnectionHealthTarget>();
  private startedAt = Date.now();

  // connection → sessionId 映射，用于按 session 广播
  private connectionSessions = new Map<string, string>();

  // webhook chatId → sessionId 映射（飞书等 IM 渠道）
  private webhookChatSessions = new Map<string, string>();

  constructor(options: GatewayOptions) {
    this.port = options.port ?? 4000;
    this.hostname = options.hostname ?? "localhost";
    this.db = options.db;
    this.toolRegistry = options.toolRegistry;
    this.onChat = options.onChat;
    this.onWebhookChat = options.onWebhookChat;
    this.onAbort = options.onAbort;
    this.onInject = options.onInject;
    this.getActiveSessionCount = options.getActiveSessionCount;
    this.skillManager = options.skillManager;
    this.mcpManager = options.mcpManager;
    this.cronScheduler = options.cronScheduler;
    this.eventWatcher = options.eventWatcher;
    this.memoryManager = options.memoryManager;
    this.contextRetriever = options.contextRetriever;
    this.contextIndexer = options.contextIndexer;
    this.contextMetaGenerator = options.contextMetaGenerator;
    this.simulationManager = options.simulationManager;
    this.feishuAdapter = options.feishuAdapter;
    this.teamRouter = options.teamRouter;
    this.teamMessages = options.teamMessages;
    this.projectChannels = options.projectChannels;
    this.taskQueue = options.taskQueue;
    this.onSessionSwitch = options.onSessionSwitch;

    this.taskQueue?.onTaskUpdated((task, eventType) => {
      this.broadcastToAll({ type: "task_updated", task: serializeTask(task), eventType });
      if (task.status === "awaiting_approval") {
        this.broadcastToAll({ type: "approval_needed", task: serializeTask(task) });
        this.notifyFeishuApprovalNeeded(task).catch((err) => {
          console.error(
            `[Gateway] Failed to push Feishu approval for task ${task.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    });

    // 初始化健康检查
    this.healthChecker = new HealthChecker();

    this.healthChecker.registerTarget(new LLMHealthTarget(options.llmProvider));

    this.wsHealthTarget = new WebSocketHealthTarget({
      getConnectionCount: () => this.connections.size,
      isServerRunning: () => this.server !== null,
    });
    this.healthChecker.registerTarget(this.wsHealthTarget);

    // 状态变化时：打日志 + 广播 health_alert
    this.healthChecker.onStatusChange((name, oldStatus, newStatus) => {
      console.log(
        `[HEALTH] ${name}: ${oldStatus.status} → ${newStatus.status}` +
          (newStatus.message ? ` (${newStatus.message})` : ""),
      );

      // 状态恶化时向所有客户端推送告警
      if (newStatus.status === "down" || newStatus.status === "degraded") {
        this.broadcastHealthAlert(name, oldStatus, newStatus);
      }
    });
  }

  // ----------------------------------------------------------
  // 启动 & 关闭
  // ----------------------------------------------------------

  start(): void {
    const self = this;

    this.server = Bun.serve<ConnectionData>({
      port: this.port,
      hostname: this.hostname,

      websocket: {
        open: (ws) => self.handleOpen(ws),
        message: (ws, raw) => self.handleMessage(ws, raw),
        close: (ws) => self.handleClose(ws),
        pong: (ws) => self.handlePong(ws),
      },

      fetch(req, server) {
        const url = new URL(req.url);

        // GET /health — JSON 健康检查端点（给外部监控工具用）
        if (url.pathname === "/health" && req.method === "GET") {
          return self.handleHealthEndpoint();
        }

        // POST /webhook/feishu — 飞书 IM 回调
        if (url.pathname === "/webhook/feishu" && req.method === "POST") {
          return self.handleFeishuWebhook(req);
        }

        if (url.pathname === "/ws") {
          const connectionId = crypto.randomUUID();
          const upgraded = server.upgrade(req, { data: { connectionId } });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
          return undefined;
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    this.startedAt = Date.now();
    this.healthChecker.start();
    console.log(`[Gateway] listening on ws://localhost:${this.server.port}/ws`);
    if (this.feishuAdapter) {
      console.log(`[Gateway] Feishu webhook enabled at POST /webhook/feishu`);
    }
  }

  async stop(): Promise<void> {
    // 停止健康检查
    this.healthChecker.stop();

    // 关闭所有 WebSocket 连接
    for (const [id, ws] of this.connections) {
      try {
        ws.close(1001, "server shutting down");
      } catch {
        // 连接可能已断开，忽略
      }
    }
    this.connections.clear();
    this.connectionSessions.clear();
    this.webhookChatSessions.clear();
    this.clientTargets.clear();

    // 关闭 HTTP 服务器
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }

    // 关闭数据库
    this.db.close();

    console.log("[Gateway] stopped");
  }

  // ----------------------------------------------------------
  // 公开方法：向指定连接发送消息
  // ----------------------------------------------------------

  sendToConnection(connectionId: string, msg: ServerMessage): void {
    const ws = this.connections.get(connectionId);
    if (!ws) return;
    try {
      ws.send(serializeServerMessage(msg));
    } catch {
      // 连接可能已断开
      this.connections.delete(connectionId);
    }
  }

  private broadcastToAll(msg: ServerMessage): void {
    for (const [connectionId] of this.connections) {
      this.sendToConnection(connectionId, msg);
    }
  }

  /**
   * 向指定 session 关联的所有客户端连接广播消息。
   * 返回实际发送的连接数（0 表示没有在线客户端）。
   */
  sendToSession(sessionId: string, msg: ServerMessage): number {
    let sent = 0;
    for (const [connectionId, sid] of this.connectionSessions) {
      if (sid === sessionId) {
        this.sendToConnection(connectionId, msg);
        sent++;
      }
    }
    return sent;
  }

  /** 获取 HealthChecker 实例，外部可注册 onStatusChange 回调 */
  getHealthChecker(): HealthChecker {
    return this.healthChecker;
  }

  // ----------------------------------------------------------
  // WebSocket 事件处理
  // ----------------------------------------------------------

  private handleOpen(ws: ServerWebSocket<ConnectionData>): void {
    const { connectionId } = ws.data;
    this.connections.set(connectionId, ws);

    // 注册该连接的健康检查
    const target = new ClientConnectionHealthTarget({
      ws,
      connectionId,
      onClose: (id) => {
        this.connections.delete(id);
        this.healthChecker.unregisterTarget(`WebSocket:${id}`);
        this.clientTargets.delete(id);
      },
    });
    this.clientTargets.set(connectionId, target);
    this.healthChecker.registerTarget(target);

    console.log(`[Gateway] connection opened: ${connectionId}`);
  }

  private handleClose(ws: ServerWebSocket<ConnectionData>): void {
    const { connectionId } = ws.data;
    this.connections.delete(connectionId);
    this.connectionSessions.delete(connectionId);

    // 注销该连接的健康检查
    this.healthChecker.unregisterTarget(`WebSocket:${connectionId}`);
    this.clientTargets.delete(connectionId);

    console.log(`[Gateway] connection closed: ${connectionId}`);
  }

  private handlePong(ws: ServerWebSocket<ConnectionData>): void {
    const { connectionId } = ws.data;
    const target = this.clientTargets.get(connectionId);
    target?.handlePong();
  }

  private handleMessage(ws: ServerWebSocket<ConnectionData>, raw: string | Buffer): void {
    const { connectionId } = ws.data;
    const text = typeof raw === "string" ? raw : raw.toString();

    let msg: ClientMessage;
    try {
      msg = parseClientMessage(text);
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Bad request: ${(err as Error).message}`,
      });
      return;
    }

    this.dispatch(connectionId, msg);
  }

  // ----------------------------------------------------------
  // 消息分发
  // ----------------------------------------------------------

  private dispatch(connectionId: string, msg: ClientMessage): void {
    switch (msg.type) {
      case "chat":
        return this.handleChat(connectionId, msg.sessionId, msg.content);
      case "abort":
        return this.handleAbort(connectionId, msg.sessionId);
      case "inject":
        return this.handleInject(connectionId, msg.sessionId, msg.content);
      case "create_session":
        return this.handleCreateSession(connectionId, msg.systemPrompt);
      case "load_session":
        return this.handleLoadSession(connectionId, msg.sessionId);
      case "list_sessions":
        return this.handleListSessions(connectionId);
      case "delete_session":
        return this.handleDeleteSession(connectionId, msg.sessionId);
      case "rename_session":
        return this.handleRenameSession(connectionId, msg.sessionId, msg.title);
      case "get_status":
        return this.handleGetStatus(connectionId);
      case "list_tools":
        return this.handleListTools(connectionId);
      case "list_skills":
        return this.handleListSkills(connectionId);
      case "reload_skills":
        return this.handleReloadSkills(connectionId);
      case "match_skills":
        return this.handleMatchSkills(connectionId, msg.query);
      case "list_mcp_servers":
        return this.handleListMcpServers(connectionId);
      case "reconnect_mcp":
        return this.handleReconnectMcp(connectionId, msg.name);
      case "list_cron":
        return this.handleListCron(connectionId);
      case "list_watchers":
        return this.handleListWatchers(connectionId);
      case "list_agents":
        return this.handleListAgents(connectionId);
      case "memory_search":
        return this.handleMemorySearch(connectionId, msg.query);
      case "memory_stats":
        return this.handleMemoryStats(connectionId);
      case "memory_clear":
        return this.handleMemoryClear(connectionId);
      case "list_personas":
        return this.handleListPersonas(connectionId);
      case "list_scenarios":
        return this.handleListScenarios(connectionId);
      case "list_simulation_skills":
        return this.handleListSimulationSkills(connectionId);
      case "start_simulation":
        return this.handleStartSimulation(connectionId, msg.scenarioName, msg.personaNames, msg.rounds, msg.mode);
      case "sim_inject":
        return this.handleSimInject(connectionId, msg.simId, msg.content);
      case "sim_pause":
        return this.handleSimPause(connectionId, msg.simId);
      case "sim_resume":
        return this.handleSimResume(connectionId, msg.simId);
      case "sim_stop":
        return this.handleSimStop(connectionId, msg.simId);
      case "sim_next_round":
        return this.handleSimNextRound(connectionId, msg.simId);
      case "sim_speak":
        return this.handleSimSpeak(connectionId, msg.simId, msg.content);
      case "sim_end":
        return this.handleSimEnd(connectionId, msg.simId);
      case "update_persona":
        return this.handleUpdatePersona(connectionId, msg.name, msg.content);
      case "update_scenario":
        return this.handleUpdateScenario(connectionId, msg.name, msg.content);
      case "generate_content":
        return this.handleGenerateContent(connectionId, msg.target, msg.prompt);
      case "context_map":
        return this.handleContextMap(connectionId);
      case "context_overview":
        return this.handleContextOverview(connectionId, msg.path);
      case "context_search":
        return this.handleContextSearch(connectionId, msg.query, msg.topK);
      case "context_rebuild":
        return this.handleContextRebuild(connectionId);
      case "inbox_get":
        return this.handleInboxGet(connectionId);
      case "inbox_add":
        return this.handleInboxAdd(connectionId, msg.content);
      case "route_human_message":
        return this.handleRouteHumanMessage(connectionId, msg);
      case "send_agent_dm":
        return this.handleSendAgentDm(connectionId, msg.agentName, msg.content, {
          userId: msg.userId,
          priority: msg.priority,
          taskId: msg.taskId,
        });
      case "send_project_message":
        return this.handleSendProjectMessage(connectionId, msg.project, msg.content, {
          userId: msg.userId,
          priority: msg.priority,
          taskId: msg.taskId,
        });
      case "bind_project_channel":
        return this.handleBindProjectChannel(connectionId, msg.project, {
          externalChannel: msg.externalChannel,
          externalChatId: msg.externalChatId,
          userId: msg.userId,
        });
      case "list_project_channels":
        return this.handleListProjectChannels(connectionId, msg.status, msg.limit);
      case "get_project_channel":
        return this.handleGetProjectChannel(connectionId, msg.project, msg.limit);
      case "get_team_messages":
        return this.handleGetTeamMessages(connectionId, msg);
      case "list_tasks":
        return this.handleListTasks(connectionId, msg);
      case "approve_task":
        return this.handleApproveTask(connectionId, msg.taskId, msg.response, msg.userId);
      case "reject_task":
        return this.handleRejectTask(connectionId, msg.taskId, msg.response, msg.userId);
      case "cancel_task":
        return this.handleCancelTask(connectionId, msg.taskId, msg.reason, msg.userId);
      case "ping":
        return this.sendToConnection(connectionId, { type: "pong" });
      case "health_check":
        return this.handleHealthCheck(connectionId);
    }
  }

  // ----------------------------------------------------------
  // Handler 实现
  // ----------------------------------------------------------

  private handleChat(connectionId: string, sessionId: string, content: string): void {
    if (!this.onChat) {
      this.sendToConnection(connectionId, {
        type: "error",
        sessionId,
        message: "Chat handler not configured",
      });
      return;
    }
    // 跟踪 connection → session 映射
    this.connectionSessions.set(connectionId, sessionId);
    this.onChat(connectionId, sessionId, content);
  }

  private handleAbort(connectionId: string, sessionId: string): void {
    console.log(`[abort] GatewayServer: received abort for session ${sessionId} from connection ${connectionId}`);
    const success = this.onAbort ? this.onAbort(sessionId) : false;
    if (success) {
      this.sendToConnection(connectionId, { type: "aborted", sessionId });
    } else {
      this.sendToConnection(connectionId, {
        type: "error",
        sessionId,
        message: "Abort failed: session not found or not running",
      });
    }
  }

  private handleInject(connectionId: string, sessionId: string, content: string): void {
    const success = this.onInject ? this.onInject(sessionId, content) : false;
    if (success) {
      this.sendToConnection(connectionId, { type: "injected", sessionId });
    } else {
      this.sendToConnection(connectionId, {
        type: "error",
        sessionId,
        message: "Inject failed: session not found or not running",
      });
    }
  }

  private handleCreateSession(connectionId: string, systemPrompt?: string): void {
    try {
      const session = this.db.createSession(systemPrompt);
      const info: SessionInfo = {
        id: session.id,
        title: session.title,
        system_prompt: session.system_prompt,
        created_at: session.created_at,
        updated_at: session.updated_at,
      };
      // 跟踪 connection → session 映射
      this.connectionSessions.set(connectionId, session.id);
      this.sendToConnection(connectionId, { type: "session_created", session: info });
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Failed to create session: ${(err as Error).message}`,
      });
    }
  }

  private handleLoadSession(connectionId: string, sessionId: string): void {
    try {
      const session = this.db.getSession(sessionId);
      if (!session) {
        this.sendToConnection(connectionId, {
          type: "error",
          sessionId,
          message: `Session not found: ${sessionId}`,
        });
        return;
      }

      // 跟踪 connection → session 映射
      const oldSessionId = this.connectionSessions.get(connectionId);
      if (oldSessionId && oldSessionId !== sessionId && this.onSessionSwitch) {
        this.onSessionSwitch(oldSessionId, sessionId);
      }
      this.connectionSessions.set(connectionId, sessionId);

      const info: SessionInfo = {
        id: session.id,
        title: session.title,
        system_prompt: session.system_prompt,
        created_at: session.created_at,
        updated_at: session.updated_at,
      };

      // 取最近 10 条消息作为摘要
      const allMessages = this.db.getMessages(sessionId);
      const recent = allMessages.slice(-10);
      const recentMessages: MessageSummary[] = recent.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
      }));

      this.sendToConnection(connectionId, {
        type: "session_loaded",
        session: info,
        recentMessages,
      });
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        sessionId,
        message: `Failed to load session: ${(err as Error).message}`,
      });
    }
  }

  private handleListSessions(connectionId: string): void {
    try {
      const sessions = this.db.listSessions()
        .filter((s) => s.title !== null || this.db.getMessageCount(s.id) > 0);
      const list: SessionInfo[] = sessions.map((s) => ({
        id: s.id,
        title: s.title,
        system_prompt: s.system_prompt,
        created_at: s.created_at,
        updated_at: s.updated_at,
      }));
      this.sendToConnection(connectionId, { type: "sessions_list", sessions: list });
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Failed to list sessions: ${(err as Error).message}`,
      });
    }
  }

  private handleDeleteSession(connectionId: string, sessionId: string): void {
    try {
      const session = this.db.getSession(sessionId);
      if (!session) {
        this.sendToConnection(connectionId, {
          type: "error",
          sessionId,
          message: `Session not found: ${sessionId}`,
        });
        return;
      }
      this.db.deleteSession(sessionId);
      // 删除成功后返回更新后的 session 列表
      this.handleListSessions(connectionId);
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        sessionId,
        message: `Failed to delete session: ${(err as Error).message}`,
      });
    }
  }

  private handleListTools(connectionId: string): void {
    const tools = this.toolRegistry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    this.sendToConnection(connectionId, { type: "tools_list", tools });
  }

  private handleListSkills(connectionId: string): void {
    if (!this.skillManager) {
      this.sendToConnection(connectionId, { type: "skills_list", skills: [] });
      return;
    }

    const skills: SkillInfo[] = this.skillManager.getAllSkills().map((s) => {
      const info: SkillInfo = {
        name: s.parsed.name,
        version: s.parsed.version,
        emoji: s.parsed.emoji,
        description: s.parsed.description,
        status: s.status,
      };

      // 统计指令数（按 markdown ## 章节计）
      const headings = s.parsed.instructions.match(/^#{1,3}\s+/gm);
      if (headings) {
        info.instructionCount = headings.length;
      }

      // unavailable 时附带缺失依赖信息
      if (s.status === "unavailable" && s.gating) {
        const parts: string[] = [];
        if (s.gating.missingEnv.length > 0) {
          parts.push(s.gating.missingEnv.join(", "));
        }
        if (s.gating.missingBins.length > 0) {
          parts.push(s.gating.missingBins.join(", "));
        }
        if (s.gating.missingConfig.length > 0) {
          parts.push(s.gating.missingConfig.join(", "));
        }
        if (parts.length > 0) {
          info.missingDeps = parts.join("; ");
        }
      }

      return info;
    });

    this.sendToConnection(connectionId, { type: "skills_list", skills });
  }

  private handleReloadSkills(connectionId: string): void {
    if (!this.skillManager) {
      this.sendToConnection(connectionId, { type: "skills_list", skills: [] });
      return;
    }

    this.skillManager
      .reload()
      .then(() => {
        this.handleListSkills(connectionId);
      })
      .catch((err) => {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Failed to reload skills: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private handleMatchSkills(connectionId: string, query: string): void {
    if (!this.skillManager) {
      this.sendToConnection(connectionId, { type: "skills_match_result", skills: [] });
      return;
    }

    const retriever = this.skillManager.getRetriever();
    if (!retriever) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: "Skill retriever not available (no embedding provider configured)",
      });
      return;
    }

    retriever
      .retrieve(query, 5)
      .then((results) => {
        this.sendToConnection(connectionId, {
          type: "skills_match_result",
          skills: results.map((r) => ({
            name: r.skill.name,
            score: r.score,
            matchReason: r.matchReason,
          })),
        });
      })
      .catch((err) => {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Skill match failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private handleListMcpServers(connectionId: string): void {
    if (!this.mcpManager) {
      this.sendToConnection(connectionId, { type: "mcp_servers_list", servers: [] });
      return;
    }
    this.sendToConnection(connectionId, {
      type: "mcp_servers_list",
      servers: this.mcpManager.getStatus(),
    });
  }

  private handleReconnectMcp(connectionId: string, name: string): void {
    if (!this.mcpManager) {
      this.sendToConnection(connectionId, {
        type: "mcp_reconnected",
        name,
        success: false,
        error: "MCP not configured",
      });
      return;
    }

    this.mcpManager
      .reconnect(name)
      .then(() => {
        this.sendToConnection(connectionId, {
          type: "mcp_reconnected",
          name,
          success: true,
        });
      })
      .catch((err) => {
        this.sendToConnection(connectionId, {
          type: "mcp_reconnected",
          name,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private handleListCron(connectionId: string): void {
    if (!this.cronScheduler) {
      this.sendToConnection(connectionId, { type: "cron_list", jobs: [] });
      return;
    }

    const jobs: CronJobInfo[] = this.cronScheduler.listJobs().map((j) => ({
      id: j.id,
      name: j.name,
      cronExpr: j.cronExpr,
      prompt: j.prompt,
      sessionId: j.sessionId,
      enabled: j.enabled,
      nextRunAt: j.nextRunAt,
      lastRunAt: j.lastRunAt,
    }));

    this.sendToConnection(connectionId, { type: "cron_list", jobs });
  }

  private handleListWatchers(connectionId: string): void {
    if (!this.eventWatcher) {
      this.sendToConnection(connectionId, { type: "watcher_list", watchers: [] });
      return;
    }

    const watchers: WatcherInfo[] = this.eventWatcher.listWatchers().map((w) => ({
      id: w.id,
      name: w.name,
      checkCommand: w.checkCommand,
      condition: w.condition,
      prompt: w.prompt,
      intervalMs: w.intervalMs,
      sessionId: w.sessionId,
      enabled: w.enabled,
      lastCheckAt: w.lastCheckAt,
      lastTriggeredAt: w.lastTriggeredAt,
    }));

    this.sendToConnection(connectionId, { type: "watcher_list", watchers });
  }

  private handleListAgents(connectionId: string): void {
    const configs = getAllAgentConfigs();
    const agents: AgentInfo[] = configs.map((c) => ({
      name: c.name,
      description: c.systemPrompt.slice(0, 120),
      allowedTools: c.allowedTools,
      maxTurns: c.maxTurns,
      canSpawnSubAgent: c.canSpawnSubAgent,
    }));
    this.sendToConnection(connectionId, { type: "agents_list", agents });
  }

  // ----------------------------------------------------------
  // Lovely Octopus Team 命令
  // ----------------------------------------------------------

  private handleRouteHumanMessage(
    connectionId: string,
    msg: Extract<ClientMessage, { type: "route_human_message" }>,
  ): void {
    if (!this.teamRouter || !this.teamMessages) {
      this.sendToConnection(connectionId, { type: "error", message: "Team mode not configured" });
      return;
    }

    try {
      const result = this.teamRouter.routeHumanMessage({
        externalChannel: msg.externalChannel ?? "websocket",
        externalChatId: msg.externalChatId ?? connectionId,
        externalMessageId: msg.externalMessageId ?? crypto.randomUUID(),
        userId: msg.userId ?? connectionId,
        text: msg.text,
      });
      const routed = this.teamMessages.getMessage(result.messageId);
      if (!routed) throw new Error(`Routed message not found: ${result.messageId}`);
      const message = serializeTeamMessage(routed);
      this.sendToConnection(connectionId, {
        type: "human_message_routed",
        result,
        message,
      });
      this.broadcastToAll({ type: "team_message_added", message });
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Failed to route human message: ${errorMessage(err)}`,
      });
    }
  }

  private handleSendAgentDm(
    connectionId: string,
    agentName: string,
    content: string,
    options: { userId?: string; priority?: TeamMessagePriority; taskId?: string },
  ): void {
    if (!this.teamMessages) {
      this.sendToConnection(connectionId, { type: "error", message: "Team mode not configured" });
      return;
    }

    try {
      const message = this.teamMessages.createMessage({
        channelType: "agent_dm",
        channelId: agentName,
        taskId: options.taskId,
        senderType: "human",
        senderId: options.userId ?? connectionId,
        content,
        priority: options.priority,
        externalChannel: "websocket",
        externalChatId: connectionId,
        externalMessageId: crypto.randomUUID(),
      });
      const info = serializeTeamMessage(message);
      this.sendToConnection(connectionId, {
        type: "human_message_routed",
        result: {
          messageId: message.id,
          ack: `已转给 @${agentName}。`,
          routedTo: { type: "agent", id: agentName },
          asyncWorkStarted: false,
        },
        message: info,
      });
      this.broadcastToAll({ type: "team_message_added", message: info });
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Failed to send agent DM: ${errorMessage(err)}`,
      });
    }
  }

  private handleSendProjectMessage(
    connectionId: string,
    project: string,
    content: string,
    options: { userId?: string; priority?: TeamMessagePriority; taskId?: string },
  ): void {
    if (!this.projectChannels) {
      this.sendToConnection(connectionId, { type: "error", message: "Team mode not configured" });
      return;
    }

    try {
      this.ensureProjectChannel(project);
      const message = this.projectChannels.postMessage(project, {
        taskId: options.taskId,
        senderType: "human",
        senderId: options.userId ?? connectionId,
        content,
        priority: options.priority,
        externalChannel: "websocket",
        externalChatId: connectionId,
        externalMessageId: crypto.randomUUID(),
      });
      const info = serializeTeamMessage(message);
      this.sendToConnection(connectionId, {
        type: "human_message_routed",
        result: {
          messageId: message.id,
          ack: `已发到 #${project}。`,
          routedTo: { type: "project", id: project },
          asyncWorkStarted: false,
        },
        message: info,
      });
      this.broadcastToAll({ type: "team_message_added", message: info });
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Failed to send project message: ${errorMessage(err)}`,
      });
    }
  }

  private handleBindProjectChannel(
    connectionId: string,
    project: string,
    options: { externalChannel?: string; externalChatId?: string; userId?: string },
  ): void {
    if (!this.projectChannels) {
      this.sendToConnection(connectionId, { type: "error", message: "Team mode not configured" });
      return;
    }

    try {
      const channel = this.ensureProjectChannel(project);
      this.projectChannels.bindExternalChat({
        externalChannel: options.externalChannel ?? "websocket",
        externalChatId: options.externalChatId ?? connectionId,
        channelType: "project",
        channelId: channel.id,
        createdBy: options.userId ?? connectionId,
      });
      this.sendToConnection(connectionId, {
        type: "project_channel_loaded",
        channel: serializeProjectChannel(channel),
        messages: this.projectChannels.listMessages(channel.slug).map(serializeTeamMessage),
      });
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Failed to bind project channel: ${errorMessage(err)}`,
      });
    }
  }

  private handleListProjectChannels(
    connectionId: string,
    status?: "active" | "paused" | "archived",
    limit?: number,
  ): void {
    if (!this.projectChannels) {
      this.sendToConnection(connectionId, { type: "project_channels_list", channels: [] });
      return;
    }
    this.sendToConnection(connectionId, {
      type: "project_channels_list",
      channels: this.projectChannels.listChannels({ status, limit }).map(serializeProjectChannel),
    });
  }

  private handleGetProjectChannel(connectionId: string, project: string, limit?: number): void {
    if (!this.projectChannels) {
      this.sendToConnection(connectionId, { type: "error", message: "Team mode not configured" });
      return;
    }

    try {
      const channel = this.projectChannels.getChannel(project);
      if (!channel) {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Project channel not found: ${project}`,
        });
        return;
      }
      this.sendToConnection(connectionId, {
        type: "project_channel_loaded",
        channel: serializeProjectChannel(channel),
        messages: this.projectChannels.listMessages(channel.slug, limit ?? 50).map(serializeTeamMessage),
      });
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Failed to load project channel: ${errorMessage(err)}`,
      });
    }
  }

  private handleGetTeamMessages(
    connectionId: string,
    msg: Extract<ClientMessage, { type: "get_team_messages" }>,
  ): void {
    if (!this.teamMessages) {
      this.sendToConnection(connectionId, { type: "team_messages_loaded", messages: [] });
      return;
    }

    this.sendToConnection(connectionId, {
      type: "team_messages_loaded",
      messages: this.teamMessages.listMessages({
        channelType: msg.channelType,
        channelId: msg.channelId,
        project: msg.project,
        taskId: msg.taskId,
        senderId: msg.senderId,
        status: msg.status,
        statuses: msg.statuses,
        limit: msg.limit,
      }).map(serializeTeamMessage),
    });
  }

  private handleListTasks(connectionId: string, msg: Extract<ClientMessage, { type: "list_tasks" }>): void {
    if (!this.taskQueue) {
      this.sendToConnection(connectionId, { type: "tasks_list", tasks: [] });
      return;
    }

    this.sendToConnection(connectionId, {
      type: "tasks_list",
      tasks: this.taskQueue.listTasks({
        status: msg.status,
        assignedTo: msg.assignedTo,
        project: msg.project,
        tags: msg.tags,
        limit: msg.limit,
      }).map(serializeTask),
    });
  }

  private handleApproveTask(connectionId: string, taskId: string, response?: string, userId?: string): void {
    this.updateTaskFromGateway(connectionId, () =>
      this.requireTaskQueue().approveTask(taskId, response ?? "Approved.", userId ?? connectionId),
    );
  }

  private handleRejectTask(connectionId: string, taskId: string, response?: string, userId?: string): void {
    this.updateTaskFromGateway(connectionId, () =>
      this.requireTaskQueue().rejectTask(taskId, response ?? "Rejected.", userId ?? connectionId),
    );
  }

  private handleCancelTask(connectionId: string, taskId: string, reason?: string, userId?: string): void {
    this.updateTaskFromGateway(connectionId, () =>
      this.requireTaskQueue().cancelTask(taskId, reason, userId ?? connectionId),
    );
  }

  private updateTaskFromGateway(connectionId: string, update: () => Task): void {
    try {
      const task = update();
      this.sendToConnection(connectionId, { type: "task_updated", task: serializeTask(task) });
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Failed to update task: ${errorMessage(err)}`,
      });
    }
  }

  private requireTaskQueue(): TaskQueue {
    if (!this.taskQueue) {
      throw new Error("Team mode not configured");
    }
    return this.taskQueue;
  }

  private ensureProjectChannel(project: string): ProjectChannel {
    if (!this.projectChannels) {
      throw new Error("Team mode not configured");
    }
    return (
      this.projectChannels.getChannel(project) ??
      this.projectChannels.createChannel({
        slug: project,
        title: titleFromSlug(project),
      })
    );
  }

  // ----------------------------------------------------------
  // Memory 命令
  // ----------------------------------------------------------

  private handleMemorySearch(connectionId: string, query: string): void {
    if (!this.memoryManager) {
      this.sendToConnection(connectionId, { type: "memory_results", results: [] });
      return;
    }

    const vs = this.memoryManager.getVectorStore();
    vs.search(query, 5)
      .then((results) => {
        const entries: MemoryResultEntry[] = results.map((r) => ({
          content: r.content,
          sessionId: r.sessionId,
          similarity: r.similarity,
          createdAt: (r.metadata.createdAt as string) ?? "unknown",
        }));
        this.sendToConnection(connectionId, { type: "memory_results", results: entries });
      })
      .catch((err) => {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Memory search failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private handleMemoryStats(connectionId: string): void {
    if (!this.memoryManager) {
      this.sendToConnection(connectionId, {
        type: "memory_stats_result",
        totalCount: 0,
        bySession: [],
      });
      return;
    }

    const vs = this.memoryManager.getVectorStore();
    this.sendToConnection(connectionId, {
      type: "memory_stats_result",
      totalCount: vs.getCount(),
      bySession: vs.getCountBySession(),
    });
  }

  private handleMemoryClear(connectionId: string): void {
    if (!this.memoryManager) {
      this.sendToConnection(connectionId, { type: "memory_cleared", deletedCount: 0 });
      return;
    }

    const vs = this.memoryManager.getVectorStore();
    const count = vs.getCount();
    vs.deleteAll();
    this.sendToConnection(connectionId, { type: "memory_cleared", deletedCount: count });
  }

  // ----------------------------------------------------------
  // Context Hub 命令
  // ----------------------------------------------------------

  private handleContextMap(connectionId: string): void {
    const fileMemory = this.memoryManager?.getFileMemory();
    if (!fileMemory) {
      this.sendToConnection(connectionId, {
        type: "context_map_result",
        map: "",
        entryCount: 0,
      });
      return;
    }
    fileMemory
      .readContextMap()
      .then((map) => {
        const text = map ?? "";
        const entryCount = text ? text.split("\n").filter((l) => l.trim()).length : 0;
        this.sendToConnection(connectionId, {
          type: "context_map_result",
          map: text,
          entryCount,
        });
      })
      .catch((err) => {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Context map failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private handleContextOverview(connectionId: string, path: string): void {
    const fileMemory = this.memoryManager?.getFileMemory();
    if (!fileMemory) {
      this.sendToConnection(connectionId, {
        type: "context_overview_result",
        path,
        overview: null,
      });
      return;
    }
    fileMemory
      .getContextHub()
      .readOverview(path)
      .then((overview) => {
        this.sendToConnection(connectionId, {
          type: "context_overview_result",
          path,
          overview,
        });
      })
      .catch((err) => {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Context overview failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private handleContextSearch(connectionId: string, query: string, topK?: number): void {
    if (!this.contextRetriever) {
      this.sendToConnection(connectionId, {
        type: "context_search_result",
        query,
        results: [],
      });
      return;
    }
    this.contextRetriever
      .retrieve(query, topK ?? 5)
      .then((scored) => {
        this.sendToConnection(connectionId, {
          type: "context_search_result",
          query,
          results: scored.map((s) => ({
            dirPath: s.dirPath,
            score: s.score,
            bm25Score: s.bm25Score,
            vectorScore: s.vectorScore,
            matchReason: s.matchReason,
            overviewPreview:
              s.overviewContent.length > 200
                ? s.overviewContent.slice(0, 200) + "..."
                : s.overviewContent,
          })),
        });
      })
      .catch((err) => {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Context search failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private handleContextRebuild(connectionId: string): void {
    if (!this.contextIndexer) {
      this.sendToConnection(connectionId, {
        type: "context_rebuild_result",
        generated: 0,
        indexed: 0,
      });
      return;
    }
    const generator = this.contextMetaGenerator;
    const indexer = this.contextIndexer;
    const db = this.db;
    (async () => {
      let generated = 0;
      if (generator) {
        const r = await generator.scanAndGenerate();
        generated = r.generated;
      }
      await indexer.indexAll();
      const indexed = db.getAllContextIndex().length;
      this.sendToConnection(connectionId, {
        type: "context_rebuild_result",
        generated,
        indexed,
      });
    })().catch((err) => {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Context rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  }

  private handleInboxGet(connectionId: string): void {
    const fileMemory = this.memoryManager?.getFileMemory();
    if (!fileMemory) {
      this.sendToConnection(connectionId, { type: "inbox_result", content: null });
      return;
    }
    fileMemory
      .readInbox()
      .then((content) => {
        this.sendToConnection(connectionId, { type: "inbox_result", content });
      })
      .catch((err) => {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Inbox read failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private handleInboxAdd(connectionId: string, content: string): void {
    const fileMemory = this.memoryManager?.getFileMemory();
    if (!fileMemory) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: "Inbox not available",
      });
      return;
    }
    const trimmed = content.trim();
    const date = new Date().toISOString().slice(0, 10);
    const looksLikeTodo = /^(todo|todo:|\[ \]|- \[ \])/i.test(trimmed);
    const line = looksLikeTodo
      ? `- [ ] ${trimmed.replace(/^(todo:?\s*|- \[ \]\s*|\[ \]\s*)/i, "")} (${date})`
      : `- ${trimmed} (${date})`;
    fileMemory
      .getContextHub()
      .writeFile("1-inbox/inbox.md", line, "append")
      .then(() => {
        this.sendToConnection(connectionId, { type: "inbox_appended", line });
      })
      .catch((err) => {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Inbox add failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  // ----------------------------------------------------------
  // Simulation 命令
  // ----------------------------------------------------------

  private handleListPersonas(connectionId: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "personas_list", personas: [] });
      return;
    }
    this.sendToConnection(connectionId, {
      type: "personas_list",
      personas: this.simulationManager.listPersonas(),
    });
  }

  private handleListScenarios(connectionId: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "scenarios_list", scenarios: [] });
      return;
    }
    this.sendToConnection(connectionId, {
      type: "scenarios_list",
      scenarios: this.simulationManager.listScenarios(),
    });
  }

  private handleListSimulationSkills(connectionId: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "simulation_skills_list", skills: [] });
      return;
    }
    this.sendToConnection(connectionId, {
      type: "simulation_skills_list",
      skills: this.simulationManager.listLoadedSkills(),
    });
  }

  private handleStartSimulation(
    connectionId: string,
    scenarioName: string,
    personaNames: string[],
    rounds?: number,
    mode?: string,
  ): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: "Simulation not configured",
      });
      return;
    }

    try {
      const { simId, events } = this.simulationManager.start(
        scenarioName,
        personaNames,
        {
          rounds,
          mode: mode as any,
        },
      );

      // 异步消费事件流，透传给客户端
      (async () => {
        try {
          for await (const event of events) {
            this.sendToConnection(connectionId, {
              type: "simulation_event",
              simId,
              event: event as any,
            });
          }
        } catch (err) {
          this.sendToConnection(connectionId, {
            type: "error",
            message: `Simulation error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })();
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Failed to start simulation: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private handleSimInject(connectionId: string, simId: string, content: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "error", message: "Simulation not configured" });
      return;
    }
    const success = this.simulationManager.inject(simId, content);
    if (!success) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Simulation not found or not running: ${simId}`,
      });
    }
  }

  private handleSimPause(connectionId: string, simId: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "error", message: "Simulation not configured" });
      return;
    }
    const success = this.simulationManager.pause(simId);
    if (!success) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Simulation not found or not running: ${simId}`,
      });
    }
  }

  private handleSimResume(connectionId: string, simId: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "error", message: "Simulation not configured" });
      return;
    }
    const success = this.simulationManager.resume(simId);
    if (!success) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Simulation not found or not running: ${simId}`,
      });
    }
  }

  private handleSimStop(connectionId: string, simId: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "error", message: "Simulation not configured" });
      return;
    }
    const success = this.simulationManager.stop(simId);
    if (!success) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Simulation not found or not running: ${simId}`,
      });
    }
  }

  private handleSimNextRound(connectionId: string, simId: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "error", message: "Simulation not configured" });
      return;
    }
    const success = this.simulationManager.nextRound(simId);
    if (!success) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Simulation not found or not waiting: ${simId}`,
      });
    }
  }

  private handleSimSpeak(connectionId: string, simId: string, content: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "error", message: "Simulation not configured" });
      return;
    }
    const success = this.simulationManager.speakThenNextRound(simId, content);
    if (!success) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Simulation not found or not waiting: ${simId}`,
      });
    }
  }

  private handleSimEnd(connectionId: string, simId: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "error", message: "Simulation not configured" });
      return;
    }
    const success = this.simulationManager.endSimulation(simId);
    if (!success) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: `Simulation not found or not waiting: ${simId}`,
      });
    }
  }

  private handleUpdatePersona(connectionId: string, name: string, content: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "error", message: "Simulation not configured" });
      return;
    }
    this.simulationManager.updatePersona(name, content)
      .then(() => {
        this.sendToConnection(connectionId, { type: "persona_updated", name });
      })
      .catch((err) => {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Failed to update persona: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private handleUpdateScenario(connectionId: string, name: string, content: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "error", message: "Simulation not configured" });
      return;
    }
    this.simulationManager.updateScenario(name, content)
      .then(() => {
        this.sendToConnection(connectionId, { type: "scenario_updated", name });
      })
      .catch((err) => {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Failed to update scenario: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private handleGenerateContent(connectionId: string, target: "persona" | "scenario", prompt: string): void {
    if (!this.simulationManager) {
      this.sendToConnection(connectionId, { type: "error", message: "Simulation not configured" });
      return;
    }

    const llm = this.simulationManager.getLLMProvider();

    const systemPrompt = target === "persona"
      ? `You are a creative writer that generates persona definition files in Markdown with YAML frontmatter.
Given a user description, generate a complete persona file with:
- YAML frontmatter: name, role, emoji (single emoji), tags (array of strings)
- Markdown body sections: # Identity, # Values & priorities, # Knowledge & expertise, # Behavioral tendencies, # Communication style

Each section should have detailed, vivid bullet points that bring the persona to life.
Output ONLY the markdown content, starting with --- for the frontmatter. No extra explanation.`
      : `You are a creative writer that generates simulation scenario definition files in Markdown with YAML frontmatter.
Given a user description, generate a complete scenario file with:
- YAML frontmatter: name, description, mode (one of: roundtable, parallel, parallel_then_roundtable, free), rounds (number 1-5), parallel_prompt (multi-line string), roundtable_prompt (multi-line string)
- Markdown body sections: # Environment, # Constraints, # Trigger event

Each section should be detailed and immersive.
Output ONLY the markdown content, starting with --- for the frontmatter. No extra explanation.`;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: prompt },
    ];

    (async () => {
      try {
        let result = "";
        for await (const event of llm.chat(messages)) {
          if (event.type === "text_delta") {
            result += event.text;
          }
        }
        this.sendToConnection(connectionId, {
          type: "generated_content",
          target,
          content: result,
        });
      } catch (err) {
        this.sendToConnection(connectionId, {
          type: "error",
          message: `Failed to generate content: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })();
  }

  private handleRenameSession(connectionId: string, sessionId: string, title: string): void {
    try {
      const session = this.db.getSession(sessionId);
      if (!session) {
        this.sendToConnection(connectionId, {
          type: "error",
          sessionId,
          message: `Session not found: ${sessionId}`,
        });
        return;
      }
      this.db.updateSessionTitle(sessionId, title);
      const updated = this.db.getSession(sessionId)!;
      this.sendToConnection(connectionId, {
        type: "session_renamed",
        session: {
          id: updated.id,
          title: updated.title,
          system_prompt: updated.system_prompt,
          created_at: updated.created_at,
          updated_at: updated.updated_at,
        },
      });
    } catch (err) {
      this.sendToConnection(connectionId, {
        type: "error",
        sessionId,
        message: `Failed to rename session: ${(err as Error).message}`,
      });
    }
  }

  private handleGetStatus(connectionId: string): void {
    this.sendToConnection(connectionId, {
      type: "status_info",
      activeSessions: this.getActiveSessionCount?.() ?? 0,
      connections: this.connections.size,
    });
  }

  // ----------------------------------------------------------
  // Webhook: 飞书
  // ----------------------------------------------------------

  private async handleFeishuWebhook(req: Request): Promise<Response> {
    if (!this.feishuAdapter) {
      return new Response(JSON.stringify({ error: "Feishu not configured" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 0. 解密（如果配了 Encrypt Key，飞书会把整个 body 加密为 { encrypt: "..." }）
    try {
      body = this.feishuAdapter.decryptBody(body);
    } catch {
      return new Response(JSON.stringify({ error: "Decryption failed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 1. Challenge 处理（飞书首次配置 URL 验证，优先处理）
    const challenge = this.feishuAdapter.handleChallenge(body);
    if (challenge) {
      console.log(`[Feishu] Challenge request received, responding with challenge`);
      return new Response(JSON.stringify(challenge), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. 验证 token（challenge 之外的正常事件回调需要验证）
    if (!this.feishuAdapter.verifyToken(body)) {
      console.warn(`[Feishu] Token verification failed`);
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. 解析消息
    const message = this.feishuAdapter.parseToInternal(body);
    if (!message) {
      // 不是我们关心的事件类型（非文本消息、重复事件等），返回 200 让飞书不重试
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. 先返回 200（飞书要求 1s 内响应），异步处理消息并主动发送 ack。
    const { chatId } = message;

    const processor = this.teamRouter
      ? this.processFeishuTeamMessage(message)
      : this.processWebhookMessage(chatId, message.text);
    processor.catch((err) => {
      console.error(
        `[Feishu] Error processing message from chat ${chatId}:`,
        err instanceof Error ? err.message : String(err),
      );
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * 异步处理 webhook 消息：映射 session、调用 Agent、发送回复。
   */
  private async processWebhookMessage(chatId: string, text: string): Promise<void> {
    if (!this.feishuAdapter || !this.onWebhookChat) return;

    // chatId → sessionId 映射，不存在则自动创建
    let sessionId = this.webhookChatSessions.get(chatId);
    if (!sessionId) {
      const session = this.db.createSession();
      sessionId = session.id;
      this.webhookChatSessions.set(chatId, sessionId);
      console.log(`[Feishu] Created new session ${sessionId} for chat ${chatId}`);
    }

    try {
      // 调用 Agent，等待完整回复
      const reply = await this.onWebhookChat(sessionId, text);

      // 发送回复到飞书
      if (reply.trim()) {
        await this.feishuAdapter.sendToChannel(chatId, reply);
      }
    } catch (err) {
      console.error(
        `[Feishu] Agent error for chat ${chatId}, session ${sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
      // 发送错误提示给用户
      await this.feishuAdapter.sendToChannel(chatId, "抱歉，处理消息时出现了错误，请稍后重试。");
    }
  }

  /**
   * 异步处理飞书团队消息：只进入 TeamRouter，立即通过飞书发确定性 ack。
   * 后台 Worker/Coordinator 的后续进展通过任务和消息推送继续发送。
   */
  private async processFeishuTeamMessage(message: WebhookMessage): Promise<void> {
    if (!this.feishuAdapter || !this.teamRouter || !this.teamMessages) return;

    try {
      const result = this.teamRouter.routeHumanMessage({
        externalChannel: message.channelType,
        externalChatId: message.chatId,
        externalMessageId: message.externalMessageId ?? crypto.randomUUID(),
        userId: message.userId,
        text: message.text,
      });
      const routed = this.teamMessages.getMessage(result.messageId);
      if (routed) {
        this.broadcastToAll({ type: "team_message_added", message: serializeTeamMessage(routed) });
      }
      await this.feishuAdapter.sendToChannel(message.chatId, result.ack);
    } catch (err) {
      console.error(
        `[Feishu] TeamRouter error for chat ${message.chatId}:`,
        err instanceof Error ? err.message : String(err),
      );
      await this.feishuAdapter.sendToChannel(message.chatId, "消息已收到，但团队路由失败，请稍后重试。");
    }
  }

  private async notifyFeishuApprovalNeeded(task: Task): Promise<void> {
    if (!this.feishuAdapter || !this.teamMessages || !task.sourceMessageId) return;
    const source = this.teamMessages.getMessage(task.sourceMessageId);
    if (!source || source.externalChannel !== "feishu" || !source.externalChatId) return;

    const prompt = task.approvalPrompt ?? "请审批该任务。";
    await this.feishuAdapter.sendToChannel(
      source.externalChatId,
      `任务需要审批：${task.title}\n任务 ID：${task.id}\n${prompt}\n\n回复：/task ${task.id} approve 或 /task ${task.id} reject <原因>`,
    );
  }

  // ----------------------------------------------------------
  // 健康检查相关
  // ----------------------------------------------------------

  /** 响应客户端的 health_check 请求 */
  private handleHealthCheck(connectionId: string): void {
    const targets = this.buildHealthTargets();
    this.sendToConnection(connectionId, { type: "health_status", targets });
  }

  /** HTTP GET /health — JSON 健康检查端点，给外部监控工具用 */
  private handleHealthEndpoint(): Response {
    const targets = this.buildHealthTargets();

    // 计算总体状态
    let overall: "ok" | "degraded" | "down" = "ok";
    for (const t of targets) {
      if (t.status === "down") {
        overall = "down";
        break;
      }
      if (t.status === "degraded") {
        overall = "degraded";
      }
    }

    const body = JSON.stringify({
      status: overall,
      targets,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    });

    const httpStatus = overall === "down" ? 503 : 200;

    return new Response(body, {
      status: httpStatus,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** 向所有已连接的客户端广播 health_alert */
  private broadcastHealthAlert(
    name: string,
    oldStatus: HealthStatus,
    newStatus: HealthStatus,
  ): void {
    const msg: ServerMessage = {
      type: "health_alert",
      target: name,
      oldStatus: oldStatus.status,
      newStatus: newStatus.status,
      message: newStatus.message ?? "",
    };
    for (const [connectionId] of this.connections) {
      this.sendToConnection(connectionId, msg);
    }
  }

  /** 从 HealthChecker 缓存构建 HealthTargetInfo 数组（过滤掉单连接级别的 target） */
  private buildHealthTargets(): HealthTargetInfo[] {
    const targets: HealthTargetInfo[] = [];
    for (const [name, status] of this.healthChecker.getStatus()) {
      // 跳过单连接级别的心跳 target（WebSocket:conn_xxx），只暴露系统级目标
      if (name.startsWith("WebSocket:")) continue;
      targets.push({
        name,
        status: status.status,
        latencyMs: status.latencyMs,
        message: status.message,
        lastCheckedAt: status.lastCheckedAt,
      });
    }
    return targets;
  }
}

function serializeTeamMessage(message: TeamMessage): TeamMessageInfo {
  return {
    id: message.id,
    channelType: message.channelType,
    channelId: message.channelId,
    project: message.project,
    taskId: message.taskId,
    senderType: message.senderType,
    senderId: message.senderId,
    content: message.content,
    priority: message.priority,
    status: message.status,
    handledBy: message.handledBy,
    externalChannel: message.externalChannel,
    externalChatId: message.externalChatId,
    externalMessageId: message.externalMessageId,
    createdAt: message.createdAt,
    handledAt: message.handledAt,
  };
}

function serializeProjectChannel(channel: ProjectChannel): ProjectChannelInfo {
  return {
    id: channel.id,
    slug: channel.slug,
    title: channel.title,
    description: channel.description,
    status: channel.status,
    contextPath: channel.contextPath,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

function serializeTask(task: Task): TaskInfo {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assignedTo: task.assignedTo,
    createdBy: task.createdBy,
    dependsOn: task.dependsOn,
    blocks: task.blocks,
    approvalPrompt: task.approvalPrompt,
    approvalData: task.approvalData,
    approvalResponse: task.approvalResponse,
    result: task.result,
    error: task.error,
    retryCount: task.retryCount,
    maxRetries: task.maxRetries,
    tags: task.tags,
    project: task.project,
    channelId: task.channelId,
    sourceMessageId: task.sourceMessageId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    dueAt: task.dueAt,
  };
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
