import type { Server, ServerWebSocket } from "bun";
import { Database } from "../db/Database";
import { ToolRegistry } from "../tools/ToolRegistry";
import {
  parseClientMessage,
  serializeServerMessage,
  type ClientMessage,
  type ServerMessage,
  type SessionInfo,
  type MessageSummary,
} from "./protocol";

// ============================================================
// Types
// ============================================================

export interface GatewayOptions {
  port?: number;
  hostname?: string;
  db: Database;
  toolRegistry: ToolRegistry;
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

  constructor(options: GatewayOptions) {
    this.port = options.port ?? 4000;
    this.hostname = options.hostname ?? "localhost";
    this.db = options.db;
    this.toolRegistry = options.toolRegistry;
    this.onChat = options.onChat;
    this.getActiveSessionCount = options.getActiveSessionCount;
  }

  // ----------------------------------------------------------
  // 启动 & 关闭
  // ----------------------------------------------------------

  start(): void {
    this.server = Bun.serve<ConnectionData>({
      port: this.port,
      hostname: this.hostname,

      routes: {
        "/health": new Response("ok"),
      },

      websocket: {
        open: (ws) => this.handleOpen(ws),
        message: (ws, raw) => this.handleMessage(ws, raw),
        close: (ws) => this.handleClose(ws),
      },

      fetch(req, server) {
        const url = new URL(req.url);
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

    console.log(`[Gateway] listening on ws://localhost:${this.server.port}/ws`);
  }

  async stop(): Promise<void> {
    // 关闭所有 WebSocket 连接
    for (const [id, ws] of this.connections) {
      try {
        ws.close(1001, "server shutting down");
      } catch {
        // 连接可能已断开，忽略
      }
    }
    this.connections.clear();

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

  // ----------------------------------------------------------
  // WebSocket 事件处理
  // ----------------------------------------------------------

  private handleOpen(ws: ServerWebSocket<ConnectionData>): void {
    const { connectionId } = ws.data;
    this.connections.set(connectionId, ws);
    console.log(`[Gateway] connection opened: ${connectionId}`);
  }

  private handleClose(ws: ServerWebSocket<ConnectionData>): void {
    const { connectionId } = ws.data;
    this.connections.delete(connectionId);
    console.log(`[Gateway] connection closed: ${connectionId}`);
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
      const sessions = this.db.listSessions();
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
}
