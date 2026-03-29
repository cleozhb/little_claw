import type { ToolResult } from "../tools/types";
import type { Session } from "../db/Database";

// ============================================================
// Shared Types
// ============================================================

/** 对外暴露的 Session 信息（从 DB Session 映射） */
export type SessionInfo = Pick<Session, "id" | "title" | "system_prompt" | "created_at" | "updated_at">;

/** 简化的消息摘要，用于 session_loaded 时回传最近消息 */
export interface MessageSummary {
  role: string;
  content: string;
  createdAt: string;
}

/** 工具描述信息 */
export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ============================================================
// Client → Server Messages
// ============================================================

export interface ChatMessage {
  type: "chat";
  sessionId: string;
  content: string;
}

export interface CreateSessionMessage {
  type: "create_session";
  systemPrompt?: string;
}

export interface LoadSessionMessage {
  type: "load_session";
  sessionId: string;
}

export interface ListSessionsMessage {
  type: "list_sessions";
}

export interface DeleteSessionMessage {
  type: "delete_session";
  sessionId: string;
}

export interface ListToolsMessage {
  type: "list_tools";
}

export interface RenameSessionMessage {
  type: "rename_session";
  sessionId: string;
  title: string;
}

export interface GetStatusMessage {
  type: "get_status";
}

export interface PingMessage {
  type: "ping";
}

export type ClientMessage =
  | ChatMessage
  | CreateSessionMessage
  | LoadSessionMessage
  | ListSessionsMessage
  | DeleteSessionMessage
  | RenameSessionMessage
  | GetStatusMessage
  | ListToolsMessage
  | PingMessage;

// ============================================================
// Server → Client Messages
// ============================================================

export interface TextDeltaMessage {
  type: "text_delta";
  sessionId: string;
  text: string;
}

export interface ToolCallMessage {
  type: "tool_call";
  sessionId: string;
  name: string;
  params: Record<string, unknown>;
}

export interface ToolResultMessage {
  type: "tool_result";
  sessionId: string;
  name: string;
  result: ToolResult;
}

export interface DoneMessage {
  type: "done";
  sessionId: string;
  usage: Record<string, unknown>;
}

export interface ErrorMessage {
  type: "error";
  sessionId?: string;
  message: string;
}

export interface SessionCreatedMessage {
  type: "session_created";
  session: SessionInfo;
}

export interface SessionLoadedMessage {
  type: "session_loaded";
  session: SessionInfo;
  recentMessages: MessageSummary[];
}

export interface SessionsListMessage {
  type: "sessions_list";
  sessions: SessionInfo[];
}

export interface ToolsListMessage {
  type: "tools_list";
  tools: ToolInfo[];
}

export interface SessionRenamedMessage {
  type: "session_renamed";
  session: SessionInfo;
}

export interface StatusInfoMessage {
  type: "status_info";
  activeSessions: number;
  connections: number;
}

export interface PongMessage {
  type: "pong";
}

export type ServerMessage =
  | TextDeltaMessage
  | ToolCallMessage
  | ToolResultMessage
  | DoneMessage
  | ErrorMessage
  | SessionCreatedMessage
  | SessionLoadedMessage
  | SessionsListMessage
  | SessionRenamedMessage
  | StatusInfoMessage
  | ToolsListMessage
  | PongMessage;

// ============================================================
// 所有合法的 client message type 值
// ============================================================

const CLIENT_MESSAGE_TYPES = new Set<ClientMessage["type"]>([
  "chat",
  "create_session",
  "load_session",
  "list_sessions",
  "delete_session",
  "rename_session",
  "get_status",
  "list_tools",
  "ping",
]);

// ============================================================
// 解析 & 序列化
// ============================================================

/**
 * 将原始 WebSocket 文本帧解析为 ClientMessage。
 * 解析失败或校验不通过时抛出 Error。
 */
export function parseClientMessage(raw: string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Message must be a JSON object");
  }

  const msg = parsed as Record<string, unknown>;

  if (typeof msg.type !== "string") {
    throw new Error("Missing or invalid 'type' field");
  }

  if (!CLIENT_MESSAGE_TYPES.has(msg.type as ClientMessage["type"])) {
    throw new Error(`Unknown client message type: ${msg.type}`);
  }

  // 按 type 逐一校验必填字段
  switch (msg.type) {
    case "chat":
      requireString(msg, "sessionId");
      requireString(msg, "content");
      break;
    case "create_session":
      // systemPrompt 是可选的，但如果传了必须是 string
      if (msg.systemPrompt !== undefined && typeof msg.systemPrompt !== "string") {
        throw new Error("'systemPrompt' must be a string if provided");
      }
      break;
    case "load_session":
      requireString(msg, "sessionId");
      break;
    case "list_sessions":
      break;
    case "delete_session":
      requireString(msg, "sessionId");
      break;
    case "rename_session":
      requireString(msg, "sessionId");
      requireString(msg, "title");
      break;
    case "get_status":
      break;
    case "list_tools":
      break;
    case "ping":
      break;
  }

  return msg as unknown as ClientMessage;
}

/**
 * 将 ServerMessage 序列化为 JSON 字符串，用于通过 WebSocket 发送。
 */
export function serializeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

// ============================================================
// 内部校验辅助
// ============================================================

function requireString(obj: Record<string, unknown>, field: string): void {
  if (typeof obj[field] !== "string" || (obj[field] as string).length === 0) {
    throw new Error(`'${field}' must be a non-empty string`);
  }
}
