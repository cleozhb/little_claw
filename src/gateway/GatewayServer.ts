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
} from "./protocol";
import { HealthChecker, type HealthStatus } from "./HealthChecker.ts";
import { LLMHealthTarget } from "./health/LLMHealthTarget.ts";
import { WebSocketHealthTarget } from "./health/WebSocketHealthTarget.ts";
import { ClientConnectionHealthTarget } from "./health/ClientConnectionHealthTarget.ts";

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
  /** chat 消息的处理回调，由外部（如 SessionRouter）注入 */
  onChat?: (connectionId: string, sessionId: string, content: string) => void;
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
  private getActiveSessionCount?: GatewayOptions["getActiveSessionCount"];
  private port: number;
  private hostname: string;

  // 健康监控
  private healthChecker: HealthChecker;
  private wsHealthTarget: WebSocketHealthTarget;
  private clientTargets = new Map<string, ClientConnectionHealthTarget>();
  private startedAt = Date.now();

  constructor(options: GatewayOptions) {
    this.port = options.port ?? 4000;
    this.hostname = options.hostname ?? "localhost";
    this.db = options.db;
    this.toolRegistry = options.toolRegistry;
    this.onChat = options.onChat;
    this.getActiveSessionCount = options.getActiveSessionCount;

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
    this.onChat(connectionId, sessionId, content);
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
