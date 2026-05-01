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

export type TeamChannelType = "project" | "agent_dm" | "coordinator" | "system";
export type TeamSenderType = "human" | "agent" | "coordinator" | "system";
export type TeamMessagePriority = "low" | "normal" | "high" | "urgent";
export type TeamMessageStatus = "new" | "routed" | "acked" | "injected" | "resolved";
export type TaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "completed"
  | "failed"
  | "cancelled";

export interface TeamMessageInfo {
  id: string;
  channelType: TeamChannelType;
  channelId: string;
  project?: string;
  taskId?: string;
  senderType: TeamSenderType;
  senderId: string;
  content: string;
  priority: TeamMessagePriority;
  status: TeamMessageStatus;
  handledBy?: string;
  externalChannel?: string;
  externalChatId?: string;
  externalMessageId?: string;
  createdAt: string;
  handledAt?: string;
}

export interface ProjectChannelInfo {
  id: string;
  slug: string;
  title: string;
  description?: string;
  status: "active" | "paused" | "archived";
  contextPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskInfo {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  assignedTo?: string;
  createdBy: string;
  dependsOn: string[];
  blocks: string[];
  approvalPrompt?: string;
  approvalData?: unknown;
  approvalResponse?: string;
  result?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
  tags: string[];
  project?: string;
  channelId?: string;
  sourceMessageId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  dueAt?: string;
}

export type RouteTarget =
  | { type: "agent"; id: string }
  | { type: "project"; id: string }
  | { type: "task"; id: string }
  | { type: "coordinator"; id: string }
  | { type: "system"; id: string };

export interface RouteResultInfo {
  messageId: string;
  ack: string;
  routedTo: RouteTarget;
  asyncWorkStarted: boolean;
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

// --- Lovely Octopus Team Client Messages ---

export interface RouteHumanMessage {
  type: "route_human_message";
  text: string;
  externalChannel?: string;
  externalChatId?: string;
  externalMessageId?: string;
  userId?: string;
}

export interface SendAgentDmMessage {
  type: "send_agent_dm";
  agentName: string;
  content: string;
  userId?: string;
  priority?: TeamMessagePriority;
  taskId?: string;
}

export interface SendProjectMessage {
  type: "send_project_message";
  project: string;
  content: string;
  userId?: string;
  priority?: TeamMessagePriority;
  taskId?: string;
}

export interface BindProjectChannelMessage {
  type: "bind_project_channel";
  project: string;
  externalChannel?: string;
  externalChatId?: string;
  userId?: string;
}

export interface CreateProjectChannelMessage {
  type: "create_project_channel";
  slug: string;
  title?: string;
  description?: string;
  contextPath?: string;
  initializeContext?: boolean;
}

export interface ListProjectChannelsMessage {
  type: "list_project_channels";
  status?: "active" | "paused" | "archived";
  limit?: number;
}

export interface GetProjectChannelMessage {
  type: "get_project_channel";
  project: string;
  limit?: number;
}

export interface GetTeamMessagesMessage {
  type: "get_team_messages";
  channelType?: TeamChannelType;
  channelId?: string;
  project?: string;
  taskId?: string;
  senderId?: string;
  status?: TeamMessageStatus;
  statuses?: TeamMessageStatus[];
  limit?: number;
}

export interface ListTasksMessage {
  type: "list_tasks";
  status?: TaskStatus;
  assignedTo?: string;
  project?: string;
  tags?: string[];
  limit?: number;
}

export interface ApproveTaskMessage {
  type: "approve_task";
  taskId: string;
  response?: string;
  userId?: string;
}

export interface RejectTaskMessage {
  type: "reject_task";
  taskId: string;
  response?: string;
  userId?: string;
}

export interface CancelTaskMessage {
  type: "cancel_task";
  taskId: string;
  reason?: string;
  userId?: string;
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

export interface GetAgentDetailMessage {
  type: "get_agent_detail";
  name: string;
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

export interface ListSimulationSkillsMessage {
  type: "list_simulation_skills";
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

/** Client → Server: 查询 skill 匹配结果 */
export interface MatchSkillsMessage {
  type: "match_skills";
  query: string;
}

// --- Context Hub Client Messages ---

export interface ContextMapMessage {
  type: "context_map";
}

export interface ContextOverviewMessage {
  type: "context_overview";
  /** 相对 context-hub/ 的目录路径，如 "3-projects/little-claw" */
  path: string;
}

export interface ContextSearchMessage {
  type: "context_search";
  query: string;
  topK?: number;
}

export interface ContextRebuildMessage {
  type: "context_rebuild";
}

export interface InboxGetMessage {
  type: "inbox_get";
}

export interface InboxAddMessage {
  type: "inbox_add";
  /** 单行内容；服务端会自动加上日期前缀和 markdown 项符号 */
  content: string;
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
  | GetAgentDetailMessage
  | MemorySearchMessage
  | MemoryStatsMessage
  | MemoryClearMessage
  | AbortMessage
  | InjectMessage
  | MatchSkillsMessage
  | ListPersonasMessage
  | ListScenariosMessage
  | ListSimulationSkillsMessage
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
  | ContextMapMessage
  | ContextOverviewMessage
  | ContextSearchMessage
  | ContextRebuildMessage
  | InboxGetMessage
  | InboxAddMessage
  | RouteHumanMessage
  | SendAgentDmMessage
  | SendProjectMessage
  | BindProjectChannelMessage
  | CreateProjectChannelMessage
  | ListProjectChannelsMessage
  | GetProjectChannelMessage
  | GetTeamMessagesMessage
  | ListTasksMessage
  | ApproveTaskMessage
  | RejectTaskMessage
  | CancelTaskMessage
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
  displayName?: string;
  role?: string;
  status?: string;
  aliases?: string[];
  directMessage?: boolean;
  skills?: string[];
  taskTags?: string[];
  source?: "preset" | "team";
}

/** Server → Client: agent 配置列表 */
export interface AgentsListMessage {
  type: "agents_list";
  agents: AgentInfo[];
}

export interface AgentDetailInfo {
  name: string;
  displayName: string;
  role: string;
  status: string;
  aliases: string[];
  directMessage: boolean;
  tools: string[];
  skills: string[];
  taskTags: string[];
  currentTasks: string[];
  runtimeStatus: string;
  agentYaml: string;
  soul: string;
  agentsMd: string;
}

export interface AgentDetailLoadedMessage {
  type: "agent_detail_loaded";
  agent: AgentDetailInfo;
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

export interface SimulationSkillsListMessage {
  type: "simulation_skills_list";
  skills: Array<{ name: string; description: string }>;
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

/** Server → Client: Skill 检索匹配结果（对话时自动触发） */
export interface SkillsMatchedMessage {
  type: "skills_matched";
  sessionId: string;
  skills: Array<{ name: string; score: number; matchReason: string }>;
}

/** Server → Client: /skills match 命令的响应 */
export interface SkillsMatchResultMessage {
  type: "skills_match_result";
  skills: Array<{ name: string; score: number; matchReason: string }>;
}

// --- Context Hub Server Messages ---

/** L0 全景视图 */
export interface ContextMapResultMessage {
  type: "context_map_result";
  /** 拼接后的文本（每行 "path/ — abstract"） */
  map: string;
  /** 条目数 */
  entryCount: number;
}

/** 目录的 .overview.md 内容 */
export interface ContextOverviewResultMessage {
  type: "context_overview_result";
  path: string;
  overview: string | null;
}

/** 检索结果 */
export interface ContextSearchResultMessage {
  type: "context_search_result";
  query: string;
  results: Array<{
    dirPath: string;
    score: number;
    bm25Score: number;
    vectorScore: number;
    matchReason: string;
    overviewPreview: string;
  }>;
}

/** 重建索引结果 */
export interface ContextRebuildResultMessage {
  type: "context_rebuild_result";
  generated: number;
  indexed: number;
}

/** inbox 内容 */
export interface InboxResultMessage {
  type: "inbox_result";
  content: string | null;
}

/** inbox 追加确认 */
export interface InboxAppendedMessage {
  type: "inbox_appended";
  line: string;
}

// --- Lovely Octopus Team Server Messages ---

export interface HumanMessageRoutedMessage {
  type: "human_message_routed";
  result: RouteResultInfo;
  message: TeamMessageInfo;
}

export interface TeamMessageAddedMessage {
  type: "team_message_added";
  message: TeamMessageInfo;
}

export interface ProjectChannelsListMessage {
  type: "project_channels_list";
  channels: ProjectChannelInfo[];
}

export interface ProjectChannelLoadedMessage {
  type: "project_channel_loaded";
  channel: ProjectChannelInfo;
  messages: TeamMessageInfo[];
}

export interface ProjectChannelCreatedMessage {
  type: "project_channel_created";
  channel: ProjectChannelInfo;
}

export interface TeamMessagesLoadedMessage {
  type: "team_messages_loaded";
  messages: TeamMessageInfo[];
}

export interface TasksListMessage {
  type: "tasks_list";
  tasks: TaskInfo[];
}

export interface TaskUpdatedMessage {
  type: "task_updated";
  task: TaskInfo;
  eventType?: string;
}

export interface ApprovalNeededMessage {
  type: "approval_needed";
  task: TaskInfo;
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
  | AgentDetailLoadedMessage
  | MemoryResultsMessage
  | MemoryStatsResultMessage
  | MemoryClearedMessage
  | AbortedMessage
  | InjectedMessage
  | SkillsMatchedMessage
  | SkillsMatchResultMessage
  | PersonasListMessage
  | ScenariosListMessage
  | SimulationSkillsListMessage
  | SimulationEventMessage
  | PersonaUpdatedMessage
  | ScenarioUpdatedMessage
  | GeneratedContentMessage
  | ContextMapResultMessage
  | ContextOverviewResultMessage
  | ContextSearchResultMessage
  | ContextRebuildResultMessage
  | InboxResultMessage
  | InboxAppendedMessage
  | HumanMessageRoutedMessage
  | TeamMessageAddedMessage
  | ProjectChannelCreatedMessage
  | ProjectChannelsListMessage
  | ProjectChannelLoadedMessage
  | TeamMessagesLoadedMessage
  | TasksListMessage
  | TaskUpdatedMessage
  | ApprovalNeededMessage;

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
  "get_agent_detail",
  "memory_search",
  "memory_stats",
  "memory_clear",
  "abort",
  "inject",
  "match_skills",
  "list_personas",
  "list_scenarios",
  "list_simulation_skills",
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
  "context_map",
  "context_overview",
  "context_search",
  "context_rebuild",
  "inbox_get",
  "inbox_add",
  "route_human_message",
  "send_agent_dm",
  "send_project_message",
  "bind_project_channel",
  "create_project_channel",
  "list_project_channels",
  "get_project_channel",
  "get_team_messages",
  "list_tasks",
  "approve_task",
  "reject_task",
  "cancel_task",
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
    case "get_agent_detail":
      requireString(msg, "name");
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
    case "match_skills":
      requireString(msg, "query");
      break;
    case "list_personas":
      break;
    case "list_scenarios":
      break;
    case "list_simulation_skills":
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
    case "context_map":
      break;
    case "context_overview":
      requireString(msg, "path");
      break;
    case "context_search":
      requireString(msg, "query");
      break;
    case "context_rebuild":
      break;
    case "inbox_get":
      break;
    case "inbox_add":
      requireString(msg, "content");
      break;
    case "route_human_message":
      requireString(msg, "text");
      requireOptionalString(msg, "externalChannel");
      requireOptionalString(msg, "externalChatId");
      requireOptionalString(msg, "externalMessageId");
      requireOptionalString(msg, "userId");
      break;
    case "send_agent_dm":
      requireString(msg, "agentName");
      requireString(msg, "content");
      requireOptionalString(msg, "userId");
      requireOptionalString(msg, "taskId");
      requireOptionalPriority(msg.priority);
      break;
    case "send_project_message":
      requireString(msg, "project");
      requireString(msg, "content");
      requireOptionalString(msg, "userId");
      requireOptionalString(msg, "taskId");
      requireOptionalPriority(msg.priority);
      break;
    case "bind_project_channel":
      requireString(msg, "project");
      requireOptionalString(msg, "externalChannel");
      requireOptionalString(msg, "externalChatId");
      requireOptionalString(msg, "userId");
      break;
    case "create_project_channel":
      requireString(msg, "slug");
      requireOptionalString(msg, "title");
      requireOptionalString(msg, "description");
      requireOptionalString(msg, "contextPath");
      requireOptionalBoolean(msg, "initializeContext");
      break;
    case "list_project_channels":
      requireOptionalProjectStatus(msg.status);
      requireOptionalNumber(msg, "limit");
      break;
    case "get_project_channel":
      requireString(msg, "project");
      requireOptionalNumber(msg, "limit");
      break;
    case "get_team_messages":
      requireOptionalChannelType(msg.channelType);
      requireOptionalString(msg, "channelId");
      requireOptionalString(msg, "project");
      requireOptionalString(msg, "taskId");
      requireOptionalString(msg, "senderId");
      requireOptionalMessageStatus(msg.status);
      requireOptionalMessageStatuses(msg.statuses);
      requireOptionalNumber(msg, "limit");
      break;
    case "list_tasks":
      requireOptionalTaskStatus(msg.status);
      requireOptionalString(msg, "assignedTo");
      requireOptionalString(msg, "project");
      requireOptionalStringArray(msg.tags, "tags");
      requireOptionalNumber(msg, "limit");
      break;
    case "approve_task":
      requireString(msg, "taskId");
      requireOptionalString(msg, "response");
      requireOptionalString(msg, "userId");
      break;
    case "reject_task":
      requireString(msg, "taskId");
      requireOptionalString(msg, "response");
      requireOptionalString(msg, "userId");
      break;
    case "cancel_task":
      requireString(msg, "taskId");
      requireOptionalString(msg, "reason");
      requireOptionalString(msg, "userId");
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

function requireOptionalString(obj: Record<string, unknown>, field: string): void {
  const value = obj[field];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`'${field}' must be a string if provided`);
  }
}

function requireOptionalNumber(obj: Record<string, unknown>, field: string): void {
  const value = obj[field];
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`'${field}' must be a finite number if provided`);
  }
}

function requireOptionalBoolean(obj: Record<string, unknown>, field: string): void {
  const value = obj[field];
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`'${field}' must be a boolean if provided`);
  }
}

function requireOptionalStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`'${field}' must be an array of strings if provided`);
  }
}

function requireOptionalPriority(value: unknown): void {
  if (
    value !== undefined &&
    value !== "low" &&
    value !== "normal" &&
    value !== "high" &&
    value !== "urgent"
  ) {
    throw new Error("'priority' must be low, normal, high, or urgent if provided");
  }
}

function requireOptionalProjectStatus(value: unknown): void {
  if (
    value !== undefined &&
    value !== "active" &&
    value !== "paused" &&
    value !== "archived"
  ) {
    throw new Error("'status' must be active, paused, or archived if provided");
  }
}

function requireOptionalChannelType(value: unknown): void {
  if (
    value !== undefined &&
    value !== "project" &&
    value !== "agent_dm" &&
    value !== "coordinator" &&
    value !== "system"
  ) {
    throw new Error("'channelType' must be project, agent_dm, coordinator, or system if provided");
  }
}

function requireOptionalMessageStatus(value: unknown): void {
  if (
    value !== undefined &&
    value !== "new" &&
    value !== "routed" &&
    value !== "acked" &&
    value !== "injected" &&
    value !== "resolved"
  ) {
    throw new Error("'status' must be a valid team message status if provided");
  }
}

function requireOptionalMessageStatuses(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error("'statuses' must be an array if provided");
  }
  for (const status of value) {
    requireOptionalMessageStatus(status);
  }
}

function requireOptionalTaskStatus(value: unknown): void {
  if (
    value !== undefined &&
    value !== "pending" &&
    value !== "assigned" &&
    value !== "running" &&
    value !== "awaiting_approval" &&
    value !== "approved" &&
    value !== "rejected" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled"
  ) {
    throw new Error("'status' must be a valid task status if provided");
  }
}
