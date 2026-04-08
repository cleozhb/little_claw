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

/** Skill 描述信息 */
export interface SkillInfo {
  name: string;
  version: string;
  emoji?: string;
  description: string;
  status: "loaded" | "unavailable" | "disabled" | "error";
  missingDeps?: string;
  /** 指令数（按 markdown 章节计算） */
  instructionCount?: number;
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

export interface HealthCheckMessage {
  type: "health_check";
}

export interface ListSkillsMessage {
  type: "list_skills";
}

export interface ReloadSkillsMessage {
  type: "reload_skills";
}

export interface ListMcpServersMessage {
  type: "list_mcp_servers";
}

export interface ReconnectMcpMessage {
  type: "reconnect_mcp";
  name: string;
}

export interface ListCronMessage {
  type: "list_cron";
}

export interface ListWatchersMessage {
  type: "list_watchers";
}

export interface ListAgentsMessage {
  type: "list_agents";
}

export interface MemorySearchMessage {
  type: "memory_search";
  query: string;
}

export interface MemoryStatsMessage {
  type: "memory_stats";
}

export interface MemoryClearMessage {
  type: "memory_clear";
}

/** Client → Server: 中断当前 Agent 执行 */
export interface AbortMessage {
  type: "abort";
  sessionId: string;
}

/** Client → Server: 运行中注入指令 */
export interface InjectMessage {
  type: "inject";
  sessionId: string;
  content: string;
}

// --- Simulation Client Messages ---

export interface ListPersonasMessage {
  type: "list_personas";
}

export interface ListScenariosMessage {
  type: "list_scenarios";
}

export interface StartSimulationMessage {
  type: "start_simulation";
  scenarioName: string;
  personaNames: string[];
  rounds?: number;
  mode?: string;
}

export interface SimInjectMessage {
  type: "sim_inject";
  simId: string;
  content: string;
}

export interface SimPauseMessage {
  type: "sim_pause";
  simId: string;
}

export interface SimResumeMessage {
  type: "sim_resume";
  simId: string;
}

export interface SimStopMessage {
  type: "sim_stop";
  simId: string;
}

export interface SimNextRoundMessage {
  type: "sim_next_round";
  simId: string;
}

export interface SimSpeakMessage {
  type: "sim_speak";
  simId: string;
  content: string;
}

export interface SimEndMessage {
  type: "sim_end";
  simId: string;
}

export interface UpdatePersonaMessage {
  type: "update_persona";
  name: string;
  content: string;
}

export interface UpdateScenarioMessage {
  type: "update_scenario";
  name: string;
  content: string;
}

/** Client → Server: 使用 LLM 生成 persona 或 scenario 的完整 Markdown 内容 */
export interface GenerateContentMessage {
  type: "generate_content";
  /** "persona" 或 "scenario" */
  target: "persona" | "scenario";
  /** 用户提供的自然语言描述 */
  prompt: string;
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
  | ListSkillsMessage
  | ReloadSkillsMessage
  | ListMcpServersMessage
  | ReconnectMcpMessage
  | ListCronMessage
  | ListWatchersMessage
  | ListAgentsMessage
  | MemorySearchMessage
  | MemoryStatsMessage
  | MemoryClearMessage
  | AbortMessage
  | InjectMessage
  | ListPersonasMessage
  | ListScenariosMessage
  | StartSimulationMessage
  | SimInjectMessage
  | SimPauseMessage
  | SimResumeMessage
  | SimStopMessage
  | SimNextRoundMessage
  | SimSpeakMessage
  | SimEndMessage
  | UpdatePersonaMessage
  | UpdateScenarioMessage
  | GenerateContentMessage
  | PingMessage
  | HealthCheckMessage;

// ============================================================
// Server → Client Messages
// ============================================================

export interface TextDeltaMessage {
  type: "text_delta";
  sessionId: string;
  text: string;
  /** "scheduled" 表示来自定时任务，undefined 表示来自用户 chat */
  source?: "scheduled";
}

export interface ToolCallMessage {
  type: "tool_call";
  sessionId: string;
  name: string;
  params: Record<string, unknown>;
  source?: "scheduled";
}

export interface ToolResultMessage {
  type: "tool_result";
  sessionId: string;
  name: string;
  result: ToolResult;
  source?: "scheduled";
}

export interface DoneMessage {
  type: "done";
  sessionId: string;
  usage: Record<string, unknown>;
  source?: "scheduled";
}

export interface ErrorMessage {
  type: "error";
  sessionId?: string;
  message: string;
  source?: "scheduled";
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

export interface SkillsListMessage {
  type: "skills_list";
  skills: SkillInfo[];
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

export interface HealthTargetInfo {
  name: string;
  status: string;
  latencyMs?: number;
  message?: string;
  lastCheckedAt: string;
}

export interface HealthStatusMessage {
  type: "health_status";
  targets: HealthTargetInfo[];
}

export interface TitleUpdatedMessage {
  type: "title_updated";
  sessionId: string;
  title: string;
}

export interface HealthAlertMessage {
  type: "health_alert";
  target: string;
  oldStatus: string;
  newStatus: string;
  message: string;
}

export interface McpServerInfo {
  name: string;
  status: "connected" | "disconnected" | "error";
  toolCount: number;
  error?: string;
}

export interface McpServersListMessage {
  type: "mcp_servers_list";
  servers: McpServerInfo[];
}

export interface McpReconnectedMessage {
  type: "mcp_reconnected";
  name: string;
  success: boolean;
  error?: string;
}

/** Server → Client: 定时任务开始执行 */
export interface ScheduledRunStartMessage {
  type: "scheduled_run_start";
  sessionId: string;
  source: "cron" | "watcher";
  name: string;
}

/** Server → Client: cron job 列表 */
export interface CronListMessage {
  type: "cron_list";
  jobs: CronJobInfo[];
}

export interface CronJobInfo {
  id: string;
  name: string;
  cronExpr: string;
  prompt: string;
  sessionId: string;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
}

/** Server → Client: watcher 列表 */
export interface WatcherListMessage {
  type: "watcher_list";
  watchers: WatcherInfo[];
}

/** Server → Client: Sub-Agent 开始执行 */
export interface SubAgentStartMessage {
  type: "sub_agent_start";
  sessionId: string;
  agentName: string;
  task: string;
}

/** Server → Client: Sub-Agent 中间事件（嵌套一个正常的 ServerMessage） */
export interface SubAgentProgressMessage {
  type: "sub_agent_progress";
  sessionId: string;
  agentName: string;
  innerEvent: ServerMessage;
}

/** Server → Client: Sub-Agent 完成 */
export interface SubAgentDoneMessage {
  type: "sub_agent_done";
  sessionId: string;
  agentName: string;
  result: string;
}

/** Agent 配置描述信息，用于 /agents 命令 */
export interface AgentInfo {
  name: string;
  description: string;
  allowedTools: string[];
  maxTurns: number;
  canSpawnSubAgent: boolean;
}

/** Server → Client: agent 配置列表 */
export interface AgentsListMessage {
  type: "agents_list";
  agents: AgentInfo[];
}

/** 记忆搜索结果条目 */
export interface MemoryResultEntry {
  content: string;
  sessionId: string;
  similarity: number;
  createdAt: string;
}

/** Server → Client: 记忆搜索结果 */
export interface MemoryResultsMessage {
  type: "memory_results";
  results: MemoryResultEntry[];
}

/** Server → Client: 记忆统计信息 */
export interface MemoryStatsResultMessage {
  type: "memory_stats_result";
  totalCount: number;
  bySession: Array<{ sessionId: string; count: number }>;
}

/** Server → Client: 记忆清空确认 */
export interface MemoryClearedMessage {
  type: "memory_cleared";
  deletedCount: number;
}

/** Server → Client: Agent 已中断 */
export interface AbortedMessage {
  type: "aborted";
  sessionId: string;
}

/** Server → Client: 注入指令已接收 */
export interface InjectedMessage {
  type: "injected";
  sessionId: string;
}

// --- Simulation Server Messages ---

export interface PersonasListMessage {
  type: "personas_list";
  personas: Array<{ name: string; role: string; emoji: string; content: string }>;
}

export interface ScenariosListMessage {
  type: "scenarios_list";
  scenarios: Array<{ name: string; description: string; mode: string; content: string }>;
}

/** Server → Client: 透传 SimulationEvent，加上 simId 字段 */
export interface SimulationEventMessage {
  type: "simulation_event";
  simId: string;
  event: {
    type: string;
    [key: string]: unknown;
  };
}

export interface PersonaUpdatedMessage {
  type: "persona_updated";
  name: string;
}

export interface ScenarioUpdatedMessage {
  type: "scenario_updated";
  name: string;
}

/** Server → Client: LLM 生成的 Markdown 内容 */
export interface GeneratedContentMessage {
  type: "generated_content";
  target: "persona" | "scenario";
  content: string;
}

export interface WatcherInfo {
  id: string;
  name: string;
  checkCommand: string;
  condition: string;
  prompt: string;
  intervalMs: number;
  sessionId: string;
  enabled: boolean;
  lastCheckAt?: string;
  lastTriggeredAt?: string;
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
  | TitleUpdatedMessage
  | StatusInfoMessage
  | ToolsListMessage
  | SkillsListMessage
  | PongMessage
  | HealthStatusMessage
  | HealthAlertMessage
  | McpServersListMessage
  | McpReconnectedMessage
  | ScheduledRunStartMessage
  | CronListMessage
  | WatcherListMessage
  | SubAgentStartMessage
  | SubAgentProgressMessage
  | SubAgentDoneMessage
  | AgentsListMessage
  | MemoryResultsMessage
  | MemoryStatsResultMessage
  | MemoryClearedMessage
  | AbortedMessage
  | InjectedMessage
  | PersonasListMessage
  | ScenariosListMessage
  | SimulationEventMessage
  | PersonaUpdatedMessage
  | ScenarioUpdatedMessage
  | GeneratedContentMessage;

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
  "list_skills",
  "reload_skills",
  "list_mcp_servers",
  "reconnect_mcp",
  "list_cron",
  "list_watchers",
  "list_agents",
  "memory_search",
  "memory_stats",
  "memory_clear",
  "abort",
  "inject",
  "list_personas",
  "list_scenarios",
  "start_simulation",
  "sim_inject",
  "sim_pause",
  "sim_resume",
  "sim_stop",
  "sim_next_round",
  "sim_speak",
  "sim_end",
  "update_persona",
  "update_scenario",
  "generate_content",
  "ping",
  "health_check",
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
    case "list_skills":
      break;
    case "reload_skills":
      break;
    case "list_mcp_servers":
      break;
    case "reconnect_mcp":
      requireString(msg, "name");
      break;
    case "list_cron":
      break;
    case "list_watchers":
      break;
    case "list_agents":
      break;
    case "memory_search":
      requireString(msg, "query");
      break;
    case "memory_stats":
      break;
    case "memory_clear":
      break;
    case "abort":
      requireString(msg, "sessionId");
      break;
    case "inject":
      requireString(msg, "sessionId");
      requireString(msg, "content");
      break;
    case "list_personas":
      break;
    case "list_scenarios":
      break;
    case "start_simulation":
      requireString(msg, "scenarioName");
      if (!Array.isArray(msg.personaNames) || msg.personaNames.length === 0) {
        throw new Error("'personaNames' must be a non-empty array");
      }
      break;
    case "sim_inject":
      requireString(msg, "simId");
      requireString(msg, "content");
      break;
    case "sim_pause":
      requireString(msg, "simId");
      break;
    case "sim_resume":
      requireString(msg, "simId");
      break;
    case "sim_stop":
      requireString(msg, "simId");
      break;
    case "sim_next_round":
      requireString(msg, "simId");
      break;
    case "sim_speak":
      requireString(msg, "simId");
      requireString(msg, "content");
      break;
    case "sim_end":
      requireString(msg, "simId");
      break;
    case "update_persona":
      requireString(msg, "name");
      requireString(msg, "content");
      break;
    case "update_scenario":
      requireString(msg, "name");
      requireString(msg, "content");
      break;
    case "generate_content":
      if (msg.target !== "persona" && msg.target !== "scenario") {
        throw new Error("'target' must be 'persona' or 'scenario'");
      }
      requireString(msg, "prompt");
      break;
    case "ping":
      break;
    case "health_check":
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
