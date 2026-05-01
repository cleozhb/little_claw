/**
 * Shared protocol types — copied from src/gateway/protocol.ts
 * Keep in sync with the backend.
 */

// ============================================================
// Shared Types
// ============================================================

export interface SessionInfo {
  id: string;
  title: string;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageSummary {
  role: string;
  content: string;
  createdAt: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SkillInfo {
  name: string;
  version: string;
  emoji?: string;
  description: string;
  status: "loaded" | "unavailable" | "disabled" | "error";
  missingDeps?: string;
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

export interface RenameSessionMessage {
  type: "rename_session";
  sessionId: string;
  title: string;
}

export interface GetStatusMessage {
  type: "get_status";
}

export interface ListToolsMessage {
  type: "list_tools";
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

export interface AbortMessage {
  type: "abort";
  sessionId: string;
}

export interface InjectMessage {
  type: "inject";
  sessionId: string;
  content: string;
}

export interface PingMessage {
  type: "ping";
}

export interface HealthCheckMessage {
  type: "health_check";
}

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
  result: { success: boolean; output: string; error?: string };
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

export interface SessionRenamedMessage {
  type: "session_renamed";
  session: SessionInfo;
}

export interface TitleUpdatedMessage {
  type: "title_updated";
  sessionId: string;
  title: string;
}

export interface StatusInfoMessage {
  type: "status_info";
  activeSessions: number;
  connections: number;
}

export interface ToolsListMessage {
  type: "tools_list";
  tools: ToolInfo[];
}

export interface SkillsListMessage {
  type: "skills_list";
  skills: SkillInfo[];
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

export interface ScheduledRunStartMessage {
  type: "scheduled_run_start";
  sessionId: string;
  source: "cron" | "watcher";
  name: string;
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

export interface CronListMessage {
  type: "cron_list";
  jobs: CronJobInfo[];
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

export interface WatcherListMessage {
  type: "watcher_list";
  watchers: WatcherInfo[];
}

export interface SubAgentStartMessage {
  type: "sub_agent_start";
  sessionId: string;
  agentName: string;
  task: string;
}

export interface SubAgentProgressMessage {
  type: "sub_agent_progress";
  sessionId: string;
  agentName: string;
  innerEvent: ServerMessage;
}

export interface SubAgentDoneMessage {
  type: "sub_agent_done";
  sessionId: string;
  agentName: string;
  result: string;
}

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

export interface MemoryResultEntry {
  content: string;
  sessionId: string;
  similarity: number;
  createdAt: string;
}

export interface MemoryResultsMessage {
  type: "memory_results";
  results: MemoryResultEntry[];
}

export interface MemoryStatsResultMessage {
  type: "memory_stats_result";
  totalCount: number;
  bySession: Array<{ sessionId: string; count: number }>;
}

export interface MemoryClearedMessage {
  type: "memory_cleared";
  deletedCount: number;
}

export interface AbortedMessage {
  type: "aborted";
  sessionId: string;
}

export interface InjectedMessage {
  type: "injected";
  sessionId: string;
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

export interface GenerateContentMessage {
  type: "generate_content";
  target: "persona" | "scenario";
  prompt: string;
}

// --- Simulation Server Messages ---

export interface PersonasListMessage {
  type: "personas_list";
  personas: Array<{ name: string; role: string; emoji: string; content: string }>;
}

export interface ScenariosListMessage {
  type: "scenarios_list";
  scenarios: Array<{ name: string; description: string; mode: string; personas?: { required: string[]; optional: string[]; max?: number }; content: string }>;
}

export interface SimulationSkillsListMessage {
  type: "simulation_skills_list";
  skills: Array<{ name: string; description: string }>;
}

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

export interface GeneratedContentMessage {
  type: "generated_content";
  target: "persona" | "scenario";
  content: string;
}

export interface SkillsMatchedMessage {
  type: "skills_matched";
  sessionId: string;
  skills: Array<{ name: string; score: number; matchReason: string }>;
}

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

// --- Simulation Domain Types ---

export interface ArgumentNode {
  topic: string;
  description: string;
  supporters: string[];
  opposers: string[];
  consensusLevel: number;
  status: "consensus" | "conflict" | "open";
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
  | PersonasListMessage
  | ScenariosListMessage
  | SimulationSkillsListMessage
  | SimulationEventMessage
  | PersonaUpdatedMessage
  | ScenarioUpdatedMessage
  | GeneratedContentMessage
  | SkillsMatchedMessage
  | HumanMessageRoutedMessage
  | TeamMessageAddedMessage
  | ProjectChannelCreatedMessage
  | ProjectChannelsListMessage
  | ProjectChannelLoadedMessage
  | TeamMessagesLoadedMessage
  | TasksListMessage
  | TaskUpdatedMessage
  | ApprovalNeededMessage;
