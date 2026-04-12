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
}

export interface AgentsListMessage {
  type: "agents_list";
  agents: AgentInfo[];
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
  | GeneratedContentMessage
  | SkillsMatchedMessage;
