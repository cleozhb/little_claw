import * as readline from "node:readline/promises";
import type {
  ClientMessage,
  ServerMessage,
  SessionInfo,
  MessageSummary,
  ToolInfo,
  HealthTargetInfo,
  SkillInfo,
  McpServerInfo,
  CronJobInfo,
  WatcherInfo,
  AgentInfo,
  MemoryResultEntry,
} from "../gateway/protocol";

// ============================================================
// ANSI Colors
// ============================================================

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const BLUE = "\x1b[34m";
/** 浅粉色（256色），用于子 Agent 标识 */
const PINK = "\x1b[38;5;218m";

const MAX_RESULT_PREVIEW = 200;

// ============================================================
// Agent 标签前缀（区分主 Agent 和子 Agent 的输出）
// ============================================================

/** 主 Agent 标签：蓝色粗体 */
const MAIN_TAG = `${BLUE}${BOLD}[main]${RESET} `;
/** 子 Agent 左侧竖线 */
const SUB_AGENT_BAR = `${PINK}│${RESET} `;
/** 生成子 Agent 标签：浅粉色粗体 [agentName] */
function subTag(name: string): string {
  return `${PINK}${BOLD}[${name}]${RESET} `;
}

/** 是否处于主 agent 文本输出的行首（需要标签前缀） */
let mainAgentAtLineStart = true;
/** 连续空行计数器（用于压缩多个连续空行为一个） */
let mainAgentConsecutiveBlankLines = 0;

/** 输出主 agent 文本，在行首添加 [main] 标签，并压缩连续空行 */
function writeMainAgentText(text: string): void {
  let out = "";
  for (const ch of text) {
    if (mainAgentAtLineStart && ch === "\n") {
      // 当前是空行
      mainAgentConsecutiveBlankLines++;
      if (mainAgentConsecutiveBlankLines > 1) {
        // 跳过多余的连续空行，只保留一个
        continue;
      }
      out += MAIN_TAG;
      out += ch;
      continue;
    }
    if (mainAgentAtLineStart) {
      out += MAIN_TAG;
      mainAgentAtLineStart = false;
      mainAgentConsecutiveBlankLines = 0;
    }
    out += ch;
    if (ch === "\n") {
      mainAgentAtLineStart = true;
    }
  }
  process.stdout.write(`${CYAN}${out}${RESET}`);
}

/** 是否处于子 agent 文本输出的行首（需要缩进） */
let subAgentAtLineStart = true;
/** 子 agent 连续空行计数器 */
let subAgentConsecutiveBlankLines = 0;

/** 输出子 agent 文本，在行首添加竖线前缀，并压缩连续空行 */
function writeSubAgentText(text: string): void {
  let out = "";
  for (const ch of text) {
    if (subAgentAtLineStart && ch === "\n") {
      subAgentConsecutiveBlankLines++;
      if (subAgentConsecutiveBlankLines > 1) {
        continue;
      }
      out += SUB_AGENT_BAR;
      out += ch;
      continue;
    }
    if (subAgentAtLineStart) {
      out += SUB_AGENT_BAR;
      subAgentAtLineStart = false;
      subAgentConsecutiveBlankLines = 0;
    }
    out += ch;
    if (ch === "\n") {
      subAgentAtLineStart = true;
    }
  }
  process.stdout.write(`${CYAN}${out}${RESET}`);
}

// ============================================================
// Commands
// ============================================================

const COMMANDS = [
  "/help",
  "/clear",
  "/sessions",
  "/switch ",
  "/new",
  "/delete ",
  "/rename ",
  "/history",
  "/tools",
  "/skills",
  "/skills info ",
  "/skills install ",
  "/skills remove ",
  "/skills reload",
  "/mcp",
  "/mcp reconnect ",
  "/cron",
  "/watchers",
  "/agents",
  "/memory",
  "/memory search ",
  "/memory clear",
  "/status",
  "/quit",
  "/exit",
];

// ============================================================
// Types
// ============================================================

interface ClientOptions {
  url?: string;
  maxReconnects?: number;
}

type PendingRequest = {
  resolve: (msg: ServerMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ============================================================
// GatewayClient
// ============================================================

export class GatewayClient {
  private url: string;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private sessionTitle: string | null = null;
  private maxReconnects: number;
  private reconnectCount = 0;
  private closed = false;

  // 心跳
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  // 请求-响应匹配：某些消息（list_sessions 等）需要等待对应的响应
  private pendingRequests = new Map<string, PendingRequest>();

  // 流式事件回调：用于 chat 流式输出
  private onStreamEvent: ((msg: ServerMessage) => void) | null = null;
  private chatDoneResolve: (() => void) | null = null;
  private chatDoneReject: ((err: Error) => void) | null = null;

  // 服务端主动推送回调（scheduled_run_start 等）
  private onServerPush: ((msg: ServerMessage) => void) | null = null;

  // 历史消息缓存（来自 session_loaded）
  private recentMessages: MessageSummary[] = [];

  constructor(options?: ClientOptions) {
    this.url = options?.url ?? "ws://localhost:4000/ws";
    this.maxReconnects = options?.maxReconnects ?? 3;
  }

  // ----------------------------------------------------------
  // 连接管理
  // ----------------------------------------------------------

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectCount = 0;
        this.startHeartbeat();
        resolve();
      };

      this.ws.onerror = (event) => {
        reject(new Error(`WebSocket connection failed: ${this.url}`));
      };

      this.ws.onclose = (event) => {
        this.stopHeartbeat();
        if (!this.closed) {
          this.handleDisconnect();
        }
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };
    });
  }

  private async handleDisconnect(): Promise<void> {
    if (this.reconnectCount >= this.maxReconnects) {
      console.error(
        `\n${RED}Connection lost. Failed to reconnect after ${this.maxReconnects} attempts.${RESET}`
      );
      process.exit(1);
    }

    this.reconnectCount++;
    console.log(
      `\n${YELLOW}Connection lost. Reconnecting (${this.reconnectCount}/${this.maxReconnects})...${RESET}`
    );

    // 拒绝所有等待中的请求
    for (const [key, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error("Connection lost"));
    }
    this.pendingRequests.clear();

    // 拒绝等待中的 chat
    if (this.chatDoneReject) {
      this.chatDoneReject(new Error("Connection lost"));
      this.chatDoneResolve = null;
      this.chatDoneReject = null;
    }

    try {
      await this.reconnect();
    } catch {
      this.handleDisconnect();
    }
  }

  private reconnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const ws = new WebSocket(this.url);

        ws.onopen = () => {
          this.ws = ws;
          this.reconnectCount = 0;
          this.startHeartbeat();

          ws.onclose = (event) => {
            this.stopHeartbeat();
            if (!this.closed) {
              this.handleDisconnect();
            }
          };

          ws.onmessage = (event) => {
            this.handleMessage(event.data as string);
          };

          console.log(`${GREEN}Reconnected!${RESET}`);

          // 重连成功后重新 load 当前 session
          if (this.sessionId) {
            this.send({ type: "load_session", sessionId: this.sessionId });
          }

          resolve();
        };

        ws.onerror = () => {
          reject(new Error("Reconnect failed"));
        };
      }, 1000 * this.reconnectCount);
    });
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ----------------------------------------------------------
  // 心跳
  // ----------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping" });
      this.pongTimer = setTimeout(() => {
        // 10 秒没有 pong，视为断线
        console.log(`${YELLOW}Ping timeout, reconnecting...${RESET}`);
        this.ws?.close();
      }, 10_000);
    }, 15_000);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  // ----------------------------------------------------------
  // 消息收发
  // ----------------------------------------------------------

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** 发送请求并等待指定类型的响应 */
  private request(msg: ClientMessage, responseType: string, timeoutMs = 10_000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(responseType);
        reject(new Error(`Request timeout: ${msg.type}`));
      }, timeoutMs);

      this.pendingRequests.set(responseType, { resolve, reject, timer });
      this.send(msg);
    });
  }

  private handleMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    // pong 处理
    if (msg.type === "pong") {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      return;
    }

    // health_alert 是服务端主动推送，直接显示告警，不打断对话
    if (msg.type === "health_alert") {
      const alert = msg as { target: string; oldStatus: string; newStatus: string; message: string };
      const statusColor = alert.newStatus === "down" ? RED : YELLOW;
      const icon = alert.newStatus === "down" ? "⚠" : "⚡";
      process.stderr.write(
        `\n${statusColor}${icon} ${alert.target} is ${alert.newStatus}${alert.message ? `: ${alert.message}` : ""}${RESET}\n`,
      );
      return;
    }

    // scheduled_run_start 是服务端主动推送（定时任务开始执行）
    if (msg.type === "scheduled_run_start") {
      if (this.onServerPush) {
        this.onServerPush(msg);
      }
      return;
    }

    // 带 source: "scheduled" 标记的事件来自定时任务，路由到 onServerPush
    if ("source" in msg && (msg as { source?: string }).source === "scheduled") {
      if (this.onServerPush) {
        this.onServerPush(msg);
      }
      return;
    }

    // 检查是否有等待此类型的 pending request
    const pending = this.pendingRequests.get(msg.type);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.type);
      pending.resolve(msg);
      return;
    }

    // error 可能对应 pending request 或流式 chat
    if (msg.type === "error") {
      // 如果有流式 chat 在进行中，转发错误
      if (this.chatDoneReject) {
        this.chatDoneReject(new Error(msg.message));
        this.chatDoneResolve = null;
        this.chatDoneReject = null;
        return;
      }
      // 否则检查是否有 pending request（可能因为 server 返回 error 而非期望的类型）
      // 遍历 pending，reject 第一个
      for (const [key, req] of this.pendingRequests) {
        clearTimeout(req.timer);
        this.pendingRequests.delete(key);
        req.reject(new Error(msg.message));
        return;
      }
      // 无主错误，直接打印
      console.error(`\n${RED}Server error: ${msg.message}${RESET}`);
      return;
    }

    // title_updated 事件：随时可能到达（在 done 之后），直接更新本地标题
    if (msg.type === "title_updated") {
      const { sessionId, title } = msg as { sessionId: string; title: string };
      if (sessionId === this.sessionId) {
        this.sessionTitle = title;
      }
      return;
    }

    // 流式事件（text_delta, tool_call, tool_result, done）
    if (this.onStreamEvent) {
      this.onStreamEvent(msg);
      if (msg.type === "done") {
        const resolve = this.chatDoneResolve;
        this.chatDoneResolve = null;
        this.chatDoneReject = null;
        this.onStreamEvent = null;
        resolve?.();
      }
    }
  }

  // ----------------------------------------------------------
  // 高层 API
  // ----------------------------------------------------------

  async listSessions(): Promise<SessionInfo[]> {
    const resp = await this.request({ type: "list_sessions" }, "sessions_list");
    return (resp as { sessions: SessionInfo[] }).sessions;
  }

  async createSession(systemPrompt?: string): Promise<SessionInfo> {
    const resp = await this.request(
      { type: "create_session", systemPrompt },
      "session_created"
    );
    const session = (resp as { session: SessionInfo }).session;
    this.sessionId = session.id;
    this.sessionTitle = session.title;
    this.recentMessages = [];
    return session;
  }

  async loadSession(sessionId: string): Promise<{ session: SessionInfo; recentMessages: MessageSummary[] }> {
    const resp = await this.request(
      { type: "load_session", sessionId },
      "session_loaded"
    );
    const data = resp as { session: SessionInfo; recentMessages: MessageSummary[] };
    this.sessionId = data.session.id;
    this.sessionTitle = data.session.title;
    this.recentMessages = data.recentMessages;
    return data;
  }

  async deleteSession(sessionId: string): Promise<SessionInfo[]> {
    const resp = await this.request(
      { type: "delete_session", sessionId },
      "sessions_list"
    );
    if (sessionId === this.sessionId) {
      this.sessionId = null;
      this.sessionTitle = null;
    }
    return (resp as { sessions: SessionInfo[] }).sessions;
  }

  async renameSession(sessionId: string, title: string): Promise<SessionInfo> {
    const resp = await this.request(
      { type: "rename_session", sessionId, title },
      "session_renamed"
    );
    const session = (resp as { session: SessionInfo }).session;
    if (sessionId === this.sessionId) {
      this.sessionTitle = session.title;
    }
    return session;
  }

  async listTools(): Promise<ToolInfo[]> {
    const resp = await this.request({ type: "list_tools" }, "tools_list");
    return (resp as { tools: ToolInfo[] }).tools;
  }

  async listSkills(): Promise<SkillInfo[]> {
    const resp = await this.request({ type: "list_skills" }, "skills_list");
    return (resp as { skills: SkillInfo[] }).skills;
  }

  async reloadSkills(): Promise<SkillInfo[]> {
    const resp = await this.request({ type: "reload_skills" }, "skills_list");
    return (resp as { skills: SkillInfo[] }).skills;
  }

  async listMcpServers(): Promise<McpServerInfo[]> {
    const resp = await this.request({ type: "list_mcp_servers" }, "mcp_servers_list");
    return (resp as { servers: McpServerInfo[] }).servers;
  }

  async reconnectMcp(name: string): Promise<{ success: boolean; error?: string }> {
    const resp = await this.request(
      { type: "reconnect_mcp", name } as ClientMessage,
      "mcp_reconnected",
      30_000,
    );
    const data = resp as { name: string; success: boolean; error?: string };
    return { success: data.success, error: data.error };
  }

  async listCron(): Promise<CronJobInfo[]> {
    const resp = await this.request({ type: "list_cron" }, "cron_list");
    return (resp as { jobs: CronJobInfo[] }).jobs;
  }

  async listWatchers(): Promise<WatcherInfo[]> {
    const resp = await this.request({ type: "list_watchers" }, "watcher_list");
    return (resp as { watchers: WatcherInfo[] }).watchers;
  }

  async listAgents(): Promise<AgentInfo[]> {
    const resp = await this.request({ type: "list_agents" }, "agents_list");
    return (resp as { agents: AgentInfo[] }).agents;
  }

  async memorySearch(query: string): Promise<MemoryResultEntry[]> {
    const resp = await this.request(
      { type: "memory_search", query } as ClientMessage,
      "memory_results",
    );
    return (resp as { results: MemoryResultEntry[] }).results;
  }

  async memoryStats(): Promise<{ totalCount: number; bySession: Array<{ sessionId: string; count: number }> }> {
    const resp = await this.request({ type: "memory_stats" } as ClientMessage, "memory_stats_result");
    const data = resp as { totalCount: number; bySession: Array<{ sessionId: string; count: number }> };
    return { totalCount: data.totalCount, bySession: data.bySession };
  }

  async memoryClear(): Promise<number> {
    const resp = await this.request({ type: "memory_clear" } as ClientMessage, "memory_cleared");
    return (resp as { deletedCount: number }).deletedCount;
  }

  async getStatus(): Promise<{ activeSessions: number; connections: number }> {
    const resp = await this.request({ type: "get_status" }, "status_info");
    const data = resp as { activeSessions: number; connections: number };
    return { activeSessions: data.activeSessions, connections: data.connections };
  }

  async healthCheck(): Promise<HealthTargetInfo[]> {
    const resp = await this.request({ type: "health_check" }, "health_status");
    return (resp as { targets: HealthTargetInfo[] }).targets;
  }

  /**
   * 发送 chat 消息并通过回调接收流式事件。
   * 返回一个 Promise，在收到 done 时 resolve。
   */
  chat(content: string, onEvent: (msg: ServerMessage) => void): Promise<void> {
    if (!this.sessionId) {
      return Promise.reject(new Error("No active session"));
    }
    return new Promise((resolve, reject) => {
      this.onStreamEvent = onEvent;
      this.chatDoneResolve = resolve;
      this.chatDoneReject = reject;
      this.send({ type: "chat", sessionId: this.sessionId!, content });
    });
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getSessionTitle(): string | null {
    return this.sessionTitle;
  }

  getRecentMessages(): MessageSummary[] {
    return this.recentMessages;
  }

  /** 注册服务端主动推送回调（scheduled_run_start 等） */
  setOnServerPush(callback: (msg: ServerMessage) => void): void {
    this.onServerPush = callback;
  }
}

// ============================================================
// CLI REPL (Gateway Client Mode)
// ============================================================

export class ClientRepl {
  private client: GatewayClient;

  constructor(client: GatewayClient) {
    this.client = client;
  }

  // --- Session label for prompt ---

  private getSessionLabel(): string {
    const title = this.client.getSessionTitle() ?? "New chat";
    return title.length > 15 ? title.slice(0, 15) : title;
  }

  private getPrompt(): string {
    return `${DIM}[${this.getSessionLabel()}]${RESET} > `;
  }

  // --- Session picker at startup ---

  private async pickSession(rl: readline.Interface): Promise<void> {
    const sessions = await this.client.listSessions();
    // 服务端已过滤空 session，这里取前 5 个展示
    const visible = sessions.slice(0, 5);

    if (visible.length === 0) {
      await this.client.createSession();
      return;
    }

    console.log(`\n${BOLD}Recent sessions:${RESET}`);
    for (let i = 0; i < visible.length; i++) {
      const s = visible[i]!;
      const title = s.title ?? "Untitled";
      const time = formatTime(s.updated_at);
      console.log(`  ${YELLOW}${i + 1}${RESET}. ${title} ${DIM}(${time})${RESET}`);
    }
    console.log(`  ${YELLOW}n${RESET}. Start new session`);
    console.log();

    let answer: string;
    try {
      answer = await rl.question("Choose session: ");
    } catch {
      await this.client.createSession();
      return;
    }

    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "n" || trimmed === "") {
      await this.client.createSession();
      return;
    }

    const idx = parseInt(trimmed, 10);
    if (idx >= 1 && idx <= visible.length) {
      const chosen = visible[idx - 1]!;
      const { recentMessages } = await this.client.loadSession(chosen.id);
      this.printRecentMessages(recentMessages, 3);
    } else {
      await this.client.createSession();
    }
  }

  // --- Help ---

  private get help(): string {
    return `Available commands:
  /help                  Show this help message
  /sessions              List all sessions
  /switch <n|id>         Switch to another session
  /new                   Create a new session
  /delete <n|id>         Delete a session
  /rename <title>        Rename current session
  /history               Show recent messages from loaded session
  /tools                 List registered tools
  /skills                List all skills and their status
  /skills info <name>    Show detailed info for a skill
  /skills install <path> Install a skill from a directory
  /skills remove <name>  Remove an installed skill
  /skills reload         Reload all skills
  /mcp                   List MCP server status
  /mcp reconnect <name>  Reconnect a MCP server
  /cron                  List all cron jobs
  /watchers              List all event watchers
  /agents                List available agent types
  /memory                Show memory statistics
  /memory search <query> Search memories by query
  /memory clear          Clear all memories (requires confirmation)
  /status                Show server status
  /quit                  Exit the chat
  /exit                  Exit the chat

Multi-line input:
  Type ${CYAN}"""${RESET} to start, type ${CYAN}"""${RESET} again to send.
`;
  }

  private printWelcome(): void {
    console.log(`
${CYAN}Welcome to Little Claw! (client mode)${RESET}
Gateway: ${YELLOW}${this.client["url"]}${RESET}
Type your message and press Enter to chat.
Type ${CYAN}/help${RESET} for available commands.
`);
  }

  // --- Commands ---

  private async handleSessions(): Promise<void> {
    const sessions = await this.client.listSessions();
    if (sessions.length === 0) {
      console.log("No sessions.\n");
      return;
    }
    console.log(`${BOLD}Sessions:${RESET}`);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      const title = s.title ?? "Untitled";
      const time = formatTime(s.updated_at);
      const current = s.id === this.client.getSessionId() ? ` ${CYAN}*${RESET}` : "";
      console.log(
        `  ${YELLOW}${i + 1}${RESET}. ${title} ${DIM}(${time})${RESET}${current}`
      );
    }
    console.log();
  }

  private async handleSwitch(arg: string): Promise<void> {
    const sessions = await this.client.listSessions();
    const target = this.resolveSession(arg, sessions);
    if (!target) {
      console.log(`${RED}Session not found: ${arg}${RESET}\n`);
      return;
    }
    if (target.id === this.client.getSessionId()) {
      console.log("Already on this session.\n");
      return;
    }
    const { session, recentMessages } = await this.client.loadSession(target.id);
    console.log(`Switched to: ${YELLOW}${session.title ?? "Untitled"}${RESET}`);
    this.printRecentMessages(recentMessages, 3);
    console.log();
  }

  private async handleNew(): Promise<void> {
    await this.client.createSession();
    console.log("New session created.\n");
  }

  private async handleDelete(arg: string, rl: readline.Interface): Promise<void> {
    const sessions = await this.client.listSessions();
    const target = this.resolveSession(arg, sessions);
    if (!target) {
      console.log(`${RED}Session not found: ${arg}${RESET}\n`);
      return;
    }
    const title = target.title ?? "Untitled";
    let confirm: string;
    try {
      confirm = await rl.question(`Delete "${title}"? (y/N) `);
    } catch {
      return;
    }
    if (confirm.trim().toLowerCase() !== "y") {
      console.log("Cancelled.\n");
      return;
    }

    const wasCurrent = target.id === this.client.getSessionId();
    await this.client.deleteSession(target.id);
    console.log(`Deleted: ${title}`);

    if (wasCurrent) {
      await this.client.createSession();
      console.log("Created new session.\n");
    } else {
      console.log();
    }
  }

  private async handleRename(newTitle: string): Promise<void> {
    if (!newTitle) {
      console.log("Usage: /rename <new title>\n");
      return;
    }
    const sessionId = this.client.getSessionId();
    if (!sessionId) {
      console.log(`${RED}No active session.${RESET}\n`);
      return;
    }
    const session = await this.client.renameSession(sessionId, newTitle);
    console.log(`Session renamed to: ${YELLOW}${session.title}${RESET}\n`);
  }

  private async handleHistory(): Promise<void> {
    // 从服务端实时拉取最新消息（而不是用 session 加载时的缓存）
    const sessionId = this.client.getSessionId();
    if (!sessionId) {
      console.log("No active session.\n");
      return;
    }

    try {
      const { recentMessages } = await this.client.loadSession(sessionId);
      if (recentMessages.length === 0) {
        console.log("No messages in this session.\n");
        return;
      }
      console.log(`${BOLD}Recent messages (${recentMessages.length}):${RESET}`);
      for (const msg of recentMessages) {
        const role = msg.role === "user" ? `${GREEN}user${RESET}` : `${CYAN}assistant${RESET}`;
        const text = msg.content.length > 80 ? msg.content.slice(0, 80) + "..." : msg.content;
        console.log(`  ${role}: ${DIM}${text}${RESET}`);
      }
      console.log();
    } catch (err) {
      console.log(`${RED}Failed to load history: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    }
  }

  private async handleTools(): Promise<void> {
    const tools = await this.client.listTools();
    if (tools.length === 0) {
      console.log("No tools registered.\n");
      return;
    }

    // 分组
    const builtin: ToolInfo[] = [];
    const skill: ToolInfo[] = [];
    const mcp: ToolInfo[] = [];

    for (const tool of tools) {
      if (tool.name.startsWith("mcp.")) {
        mcp.push(tool);
      } else if (tool.name.startsWith("skill.")) {
        skill.push(tool);
      } else {
        builtin.push(tool);
      }
    }

    if (builtin.length > 0) {
      console.log(`${BOLD}Built-in:${RESET}`);
      for (const t of builtin) {
        console.log(`  ${YELLOW}${t.name}${RESET} - ${DIM}${t.description}${RESET}`);
      }
    }

    if (skill.length > 0) {
      console.log(`${BOLD}Skills:${RESET}`);
      for (const t of skill) {
        console.log(`  ${YELLOW}${t.name}${RESET} - ${DIM}${t.description}${RESET}`);
      }
    }

    if (mcp.length > 0) {
      console.log(`${BOLD}MCP:${RESET}`);
      for (const t of mcp) {
        // 提取 server 名：mcp.{server}.{tool}
        const parts = t.name.split(".");
        const server = parts.length >= 3 ? parts[1] : "unknown";
        console.log(`  ${YELLOW}${t.name}${RESET} ${DIM}[${server}]${RESET} - ${DIM}${t.description}${RESET}`);
      }
    }

    console.log();
  }

  // --- Skills commands ---

  private async handleSkills(): Promise<void> {
    const skills = await this.client.listSkills();
    if (skills.length === 0) {
      console.log("No skills found.\n");
      return;
    }

    console.log(`${BOLD}Skills:${RESET}`);

    // 计算最长名称+版本用于对齐
    const nameVersions = skills.map(
      (s) => `${s.emoji ?? "📦"} ${s.name} v${s.version}`,
    );
    const maxLen = Math.max(...nameVersions.map((nv) => nv.length));

    for (let i = 0; i < skills.length; i++) {
      const s = skills[i]!;
      const nv = nameVersions[i]!;
      const pad = " ".repeat(Math.max(1, maxLen - nv.length + 2));

      let statusIcon: string;
      let statusColor: string;
      let extra = "";

      switch (s.status) {
        case "loaded":
          statusIcon = "✅";
          statusColor = GREEN;
          if (s.instructionCount) {
            extra = ` (${s.instructionCount} instructions)`;
          }
          break;
        case "unavailable":
          statusIcon = "⚠️ ";
          statusColor = YELLOW;
          if (s.missingDeps) {
            extra = ` (missing: ${s.missingDeps})`;
          }
          break;
        case "disabled":
          statusIcon = "⛔";
          statusColor = RED;
          extra = " disabled by config";
          break;
        case "error":
          statusIcon = "❌";
          statusColor = RED;
          extra = " error";
          break;
        default:
          statusIcon = "?";
          statusColor = DIM;
      }

      console.log(
        `${statusIcon} ${statusColor}${nv}${RESET}${pad}— ${DIM}${s.description}${RESET}${extra ? ` ${DIM}${extra}${RESET}` : ""}`,
      );
    }
    console.log();
  }

  private async handleSkillInfo(name: string): Promise<void> {
    if (!name) {
      console.log("Usage: /skills info <name>\n");
      return;
    }

    const skills = await this.client.listSkills();
    const skill = skills.find((s) => s.name === name);

    if (!skill) {
      console.log(`${RED}Skill not found: ${name}${RESET}\n`);
      return;
    }

    console.log(`${BOLD}${skill.emoji ?? "📦"} ${skill.name}${RESET} v${skill.version}`);
    console.log(`  Description: ${skill.description}`);
    console.log(`  Status:      ${this.formatSkillStatus(skill)}`);
    if (skill.missingDeps) {
      console.log(`  Missing:     ${YELLOW}${skill.missingDeps}${RESET}`);
    }
    if (skill.instructionCount) {
      console.log(`  Instructions: ${skill.instructionCount} sections`);
    }
    console.log();
  }

  private async handleSkillInstall(
    pathArg: string,
    rl: readline.Interface,
  ): Promise<void> {
    if (!pathArg) {
      console.log("Usage: /skills install <path>\n");
      return;
    }

    const { resolve, basename, join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { cpSync, existsSync } = await import("node:fs");

    const sourcePath = resolve(pathArg);

    // 验证源目录存在 SKILL.md
    const skillMdPath = join(sourcePath, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      console.log(`${RED}No SKILL.md found in ${sourcePath}${RESET}\n`);
      return;
    }

    const skillName = basename(sourcePath);
    const targetDir = join(homedir(), ".little_claw", "skills", skillName);

    if (existsSync(targetDir)) {
      let confirm: string;
      try {
        confirm = await rl.question(
          `Skill "${skillName}" already exists. Overwrite? (y/N) `,
        );
      } catch {
        return;
      }
      if (confirm.trim().toLowerCase() !== "y") {
        console.log("Cancelled.\n");
        return;
      }
    }

    try {
      cpSync(sourcePath, targetDir, { recursive: true });
      console.log(`${GREEN}Installed ${skillName} to ${targetDir}${RESET}`);
      console.log(`${DIM}Run /skills reload to activate.${RESET}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${RED}Failed to install: ${msg}${RESET}\n`);
    }
  }

  private async handleSkillRemove(
    name: string,
    rl: readline.Interface,
  ): Promise<void> {
    if (!name) {
      console.log("Usage: /skills remove <name>\n");
      return;
    }

    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { existsSync, rmSync } = await import("node:fs");

    const targetDir = join(homedir(), ".little_claw", "skills", name);

    if (!existsSync(targetDir)) {
      console.log(`${RED}Skill not found: ${targetDir}${RESET}\n`);
      return;
    }

    let confirm: string;
    try {
      confirm = await rl.question(`Remove skill "${name}"? (y/N) `);
    } catch {
      return;
    }
    if (confirm.trim().toLowerCase() !== "y") {
      console.log("Cancelled.\n");
      return;
    }

    try {
      rmSync(targetDir, { recursive: true });
      console.log(`${GREEN}Removed ${name}${RESET}`);
      console.log(`${DIM}Run /skills reload to update.${RESET}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${RED}Failed to remove: ${msg}${RESET}\n`);
    }
  }

  // --- MCP commands ---

  private async handleMcp(): Promise<void> {
    const servers = await this.client.listMcpServers();
    if (servers.length === 0) {
      console.log("No MCP servers configured.\n");
      return;
    }

    console.log(`${BOLD}MCP Servers:${RESET}`);
    for (const s of servers) {
      let statusColor: string;
      let statusIcon: string;
      switch (s.status) {
        case "connected":
          statusColor = GREEN;
          statusIcon = "●";
          break;
        case "disconnected":
          statusColor = DIM;
          statusIcon = "○";
          break;
        case "error":
          statusColor = RED;
          statusIcon = "✕";
          break;
        default:
          statusColor = DIM;
          statusIcon = "?";
      }
      const toolInfo = s.status === "connected" ? ` (${s.toolCount} tools)` : "";
      const errorInfo = s.error ? ` — ${s.error}` : "";
      console.log(
        `  ${statusColor}${statusIcon}${RESET} ${YELLOW}${s.name}${RESET}: ${statusColor}${s.status}${RESET}${toolInfo}${DIM}${errorInfo}${RESET}`,
      );
    }
    console.log();
  }

  private async handleMcpReconnect(name: string): Promise<void> {
    if (!name) {
      console.log("Usage: /mcp reconnect <name>\n");
      return;
    }

    console.log(`${DIM}Reconnecting to "${name}"...${RESET}`);
    try {
      const result = await this.client.reconnectMcp(name);
      if (result.success) {
        console.log(`${GREEN}Reconnected to "${name}".${RESET}\n`);
      } else {
        console.log(`${RED}Failed to reconnect: ${result.error ?? "unknown error"}${RESET}\n`);
      }
    } catch (err) {
      console.log(`${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    }
  }

  private async handleCron(): Promise<void> {
    const jobs = await this.client.listCron();
    if (jobs.length === 0) {
      console.log("No cron jobs configured.\n");
      return;
    }

    console.log(`${BOLD}Cron Jobs:${RESET}`);
    for (const job of jobs) {
      const statusColor = job.enabled ? GREEN : DIM;
      const statusIcon = job.enabled ? "●" : "○";
      const nextRun = job.nextRunAt ? `next: ${formatTime(job.nextRunAt)}` : "—";
      const lastRun = job.lastRunAt ? `last: ${formatTime(job.lastRunAt)}` : "never run";
      console.log(
        `  ${statusColor}${statusIcon}${RESET} ${YELLOW}${job.name}${RESET} ${DIM}(${job.cronExpr})${RESET}`,
      );
      console.log(
        `    ${DIM}${nextRun} | ${lastRun} | session: ${job.sessionId.slice(0, 8)}...${RESET}`,
      );
    }
    console.log();
  }

  private async handleWatchers(): Promise<void> {
    const watchers = await this.client.listWatchers();
    if (watchers.length === 0) {
      console.log("No watchers configured.\n");
      return;
    }

    console.log(`${BOLD}Event Watchers:${RESET}`);
    for (const w of watchers) {
      const statusColor = w.enabled ? GREEN : DIM;
      const statusIcon = w.enabled ? "●" : "○";
      const intervalMin = w.intervalMs / 60_000;
      const lastCheck = w.lastCheckAt ? `last check: ${formatTime(w.lastCheckAt)}` : "never checked";
      const lastTrigger = w.lastTriggeredAt ? `last trigger: ${formatTime(w.lastTriggeredAt)}` : "never triggered";
      console.log(
        `  ${statusColor}${statusIcon}${RESET} ${YELLOW}${w.name}${RESET} ${DIM}(every ${intervalMin}m)${RESET}`,
      );
      console.log(
        `    ${DIM}${lastCheck} | ${lastTrigger} | session: ${w.sessionId.slice(0, 8)}...${RESET}`,
      );
    }
    console.log();
  }

  private async handleAgents(): Promise<void> {
    const agents = await this.client.listAgents();
    if (agents.length === 0) {
      console.log("No agent types configured.\n");
      return;
    }

    console.log(`${BOLD}Available Agent Types:${RESET}`);
    for (const a of agents) {
      const tools = a.allowedTools.length > 0
        ? a.allowedTools.join(", ")
        : "all";
      const spawn = a.canSpawnSubAgent ? `${GREEN}yes${RESET}` : `${DIM}no${RESET}`;
      console.log(`  ${YELLOW}${a.name}${RESET} ${DIM}(maxTurns: ${a.maxTurns}, canSpawn: ${spawn}${DIM})${RESET}`);
      console.log(`    ${DIM}${a.description}${RESET}`);
      console.log(`    ${DIM}tools: ${tools}${RESET}`);
    }
    console.log();
  }

  // --- Memory commands ---

  private async handleMemory(): Promise<void> {
    try {
      const stats = await this.client.memoryStats();
      console.log(`${BOLD}Memory:${RESET} ${stats.totalCount} entries across ${stats.bySession.length} sessions`);
      if (stats.bySession.length > 0) {
        for (const s of stats.bySession) {
          console.log(`  ${DIM}session ${YELLOW}${s.sessionId.slice(0, 8)}...${RESET}${DIM}: ${s.count} entries${RESET}`);
        }
      }
      console.log();
    } catch (err) {
      console.log(`${RED}Failed to get memory stats: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    }
  }

  private async handleMemorySearch(query: string): Promise<void> {
    if (!query) {
      console.log("Usage: /memory search <query>\n");
      return;
    }

    try {
      const results = await this.client.memorySearch(query);
      if (results.length === 0) {
        console.log("No matching memories found.\n");
        return;
      }

      console.log(`${BOLD}Memory search results (${results.length}):${RESET}`);
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const sim = (r.similarity * 100).toFixed(1);
        const date = r.createdAt.slice(0, 10);
        const preview = r.content.length > 100 ? r.content.slice(0, 100) + "..." : r.content;
        console.log(
          `  ${YELLOW}${i + 1}${RESET}. ${DIM}[${sim}%]${RESET} ${DIM}(${date}, session ${r.sessionId.slice(0, 8)}...)${RESET}`,
        );
        console.log(`     ${preview}`);
      }
      console.log();
    } catch (err) {
      console.log(`${RED}Memory search failed: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    }
  }

  private async handleMemoryClear(rl: readline.Interface): Promise<void> {
    let confirm: string;
    try {
      confirm = await rl.question(`${YELLOW}Clear ALL memories? This cannot be undone. (y/N) ${RESET}`);
    } catch {
      return;
    }
    if (confirm.trim().toLowerCase() !== "y") {
      console.log("Cancelled.\n");
      return;
    }

    try {
      const deleted = await this.client.memoryClear();
      console.log(`${GREEN}Cleared ${deleted} memory entries.${RESET}\n`);
    } catch (err) {
      console.log(`${RED}Failed to clear memories: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    }
  }

  private formatSkillStatus(skill: SkillInfo): string {
    switch (skill.status) {
      case "loaded":
        return `${GREEN}loaded${RESET}`;
      case "unavailable":
        return `${YELLOW}unavailable${RESET}`;
      case "disabled":
        return `${RED}disabled${RESET}`;
      case "error":
        return `${RED}error${RESET}`;
      default:
        return skill.status;
    }
  }

  private async handleStatus(): Promise<void> {
    const [status, targets] = await Promise.all([
      this.client.getStatus(),
      this.client.healthCheck(),
    ]);

    console.log(`${BOLD}Server Status:${RESET}`);
    console.log(`  Active sessions: ${YELLOW}${status.activeSessions}${RESET}`);
    console.log(`  Connections:      ${YELLOW}${status.connections}${RESET}`);

    if (targets.length > 0) {
      console.log();
      console.log(`${BOLD}Health Targets:${RESET}`);
      for (const t of targets) {
        const color =
          t.status === "healthy" ? GREEN : t.status === "degraded" ? YELLOW : RED;
        const latency = t.latencyMs !== undefined ? ` ${DIM}(${t.latencyMs}ms)${RESET}` : "";
        const msg = t.message ? ` — ${DIM}${t.message}${RESET}` : "";
        const time = t.lastCheckedAt ? ` ${DIM}[${formatTime(t.lastCheckedAt)}]${RESET}` : "";
        console.log(`  ${color}●${RESET} ${t.name}: ${color}${t.status}${RESET}${latency}${msg}${time}`);
      }
    }
    console.log();
  }

  // --- Helpers ---

  private resolveSession(
    arg: string,
    sessions: SessionInfo[]
  ): SessionInfo | null {
    const idx = parseInt(arg, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
      return sessions[idx - 1] ?? null;
    }
    return sessions.find((s) => s.id.startsWith(arg)) ?? null;
  }

  private printRecentMessages(messages: MessageSummary[], n: number): void {
    const recent = messages.slice(-n);
    if (recent.length === 0) return;
    console.log(`${DIM}--- recent messages ---${RESET}`);
    for (const msg of recent) {
      const role = msg.role === "user" ? `${GREEN}user${RESET}` : `${CYAN}assistant${RESET}`;
      const text = msg.content.length > 80 ? msg.content.slice(0, 80) + "..." : msg.content;
      console.log(`  ${role}: ${DIM}${text}${RESET}`);
    }
    console.log(`${DIM}----------------------${RESET}`);
  }

  private formatParams(params: Record<string, unknown>): string {
    const entries = Object.entries(params);
    if (entries.length === 0) return "{}";
    const parts = entries.map(([k, v]) => {
      const val =
        typeof v === "string"
          ? v.length > 60
            ? `"${v.slice(0, 57)}..."`
            : `"${v}"`
          : JSON.stringify(v);
      return `${k}: ${val}`;
    });
    return `{ ${parts.join(", ")} }`;
  }

  private truncate(text: string): string {
    if (text.length <= MAX_RESULT_PREVIEW) return text;
    return text.slice(0, MAX_RESULT_PREVIEW) + "...";
  }

  private async readMultiline(rl: readline.Interface): Promise<string> {
    const lines: string[] = [];
    console.log(`${DIM}(multi-line mode, type """ to end)${RESET}`);
    while (true) {
      let line: string;
      try {
        line = await rl.question("... ");
      } catch {
        break;
      }
      if (line.trim() === '"""') break;
      lines.push(line);
    }
    return lines.join("\n");
  }

  // --- Main loop ---

  async start(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line: string): [string[], string] => {
        if (line.startsWith("/")) {
          const hits = COMMANDS.filter((c) => c.startsWith(line));
          return [hits.length ? hits : COMMANDS, line];
        }
        return [[], line];
      },
    });

    this.printWelcome();
    await this.pickSession(rl);

    // 注册服务端主动推送回调：处理定时任务触发的输出
    let scheduledFirstToken = true;
    this.client.setOnServerPush((msg) => {
      switch (msg.type) {
        case "scheduled_run_start": {
          const srs = msg as { source: string; name: string };
          const label = srs.source === "cron" ? "Cron" : "Watcher";
          process.stdout.write(`\n${YELLOW}⏰ [${label}: ${srs.name}] running...${RESET}\n`);
          scheduledFirstToken = true;
          break;
        }
        case "text_delta": {
          if (scheduledFirstToken) {
            process.stdout.write(CYAN);
            scheduledFirstToken = false;
          }
          process.stdout.write((msg as { text: string }).text);
          break;
        }
        case "tool_call": {
          if (!scheduledFirstToken) {
            process.stdout.write(RESET + "\n");
          }
          scheduledFirstToken = true;
          const tc = msg as { name: string; params: Record<string, unknown> };
          console.log(`${YELLOW}> ${tc.name}(${this.formatParams(tc.params)})${RESET}`);
          break;
        }
        case "tool_result": {
          const tr = msg as { name: string; result: { success: boolean; output: string; error?: string } };
          const status = tr.result.success ? `${GREEN}ok${RESET}` : `${RED}error${RESET}`;
          const output = tr.result.success ? tr.result.output : tr.result.error ?? "Unknown error";
          console.log(`${DIM}  [${status}${DIM}] ${this.truncate(output)}${RESET}`);
          break;
        }
        case "done": {
          if (!scheduledFirstToken) {
            process.stdout.write(RESET);
          }
          const d = msg as { usage: Record<string, unknown> };
          console.log(
            `${DIM}[tokens: ${d.usage?.totalInputTokens ?? "?"} in / ${d.usage?.totalOutputTokens ?? "?"} out]${RESET}`,
          );
          // 重新显示提示符
          process.stdout.write(this.getPrompt());
          break;
        }
        case "sub_agent_start": {
          const sas = msg as { agentName: string; task: string };
          subAgentAtLineStart = true;
          console.log(
            `\n${PINK}┌── 🤖 ${BOLD}[${sas.agentName}]${RESET}${PINK} Task: ${sas.task}${RESET}`
          );
          break;
        }
        case "sub_agent_progress": {
          const sap = msg as { agentName: string; innerEvent: ServerMessage };
          const inner = sap.innerEvent;
          switch (inner.type) {
            case "text_delta":
              writeSubAgentText(inner.text);
              break;
            case "tool_call":
              console.log(
                `${SUB_AGENT_BAR}${subTag(sap.agentName)}${YELLOW}> ${inner.name}(${this.formatParams(inner.params)})${RESET}`
              );
              break;
            case "tool_result": {
              const status = inner.result.success ? `${GREEN}ok${RESET}` : `${RED}error${RESET}`;
              const output = inner.result.success ? inner.result.output : inner.result.error ?? "Unknown error";
              console.log(
                `${SUB_AGENT_BAR}${subTag(sap.agentName)}${DIM}[${status}${DIM}] ${this.truncate(output)}${RESET}`
              );
              break;
            }
            case "error":
              console.log(
                `${SUB_AGENT_BAR}${subTag(sap.agentName)}${RED}⚠ ${(inner as { message: string }).message}${RESET}`
              );
              break;
            case "done": {
              const d = inner as { usage?: Record<string, unknown> };
              if (d.usage) {
                console.log(
                  `${SUB_AGENT_BAR}${DIM}[${sap.agentName} tokens: ${d.usage.totalInputTokens ?? "?"} in / ${d.usage.totalOutputTokens ?? "?"} out]${RESET}`
                );
              }
              break;
            }
          }
          break;
        }
        case "sub_agent_done": {
          const sad = msg as { agentName: string; result: string };
          console.log(
            `${PINK}└── ✅ ${BOLD}[${sad.agentName}]${RESET}${PINK} Done: ${this.truncate(sad.result)}${RESET}`
          );
          break;
        }
      }
    });

    let closed = false;
    rl.on("close", () => {
      closed = true;
    });

    const handleSigint = () => {
      console.log(`\n${RESET}Bye!`);
      this.client.close();
      rl.close();
      process.exit(0);
    };
    process.on("SIGINT", handleSigint);

    try {
      while (!closed) {
        let input: string;
        try {
          input = await rl.question(this.getPrompt());
        } catch {
          break;
        }
        if (closed) break;

        const trimmed = input.trim();
        if (!trimmed) continue;

        // Multi-line mode
        if (trimmed === '"""') {
          input = await this.readMultiline(rl);
          if (!input.trim()) continue;
        } else {
          input = trimmed;
        }

        // Commands
        if (input === "/quit" || input === "/exit") {
          console.log("Bye!");
          break;
        }

        if (input === "/help") {
          console.log(this.help);
          continue;
        }

        if (input === "/sessions") {
          await this.handleSessions();
          continue;
        }

        if (input.startsWith("/switch")) {
          const arg = input.slice(7).trim();
          if (!arg) {
            console.log("Usage: /switch <number or id>\n");
          } else {
            await this.handleSwitch(arg);
          }
          continue;
        }

        if (input === "/new") {
          await this.handleNew();
          continue;
        }

        if (input.startsWith("/delete")) {
          const arg = input.slice(7).trim();
          if (!arg) {
            console.log("Usage: /delete <number or id>\n");
          } else {
            await this.handleDelete(arg, rl);
          }
          continue;
        }

        if (input.startsWith("/rename")) {
          await this.handleRename(input.slice(7).trim());
          continue;
        }

        if (input === "/history") {
          this.handleHistory();
          continue;
        }

        if (input === "/tools") {
          await this.handleTools();
          continue;
        }

        if (input === "/skills" || input === "/skills list") {
          await this.handleSkills();
          continue;
        }

        if (input.startsWith("/skills info")) {
          await this.handleSkillInfo(input.slice(12).trim());
          continue;
        }

        if (input.startsWith("/skills install")) {
          await this.handleSkillInstall(input.slice(15).trim(), rl);
          continue;
        }

        if (input.startsWith("/skills remove")) {
          await this.handleSkillRemove(input.slice(14).trim(), rl);
          continue;
        }

        if (input === "/skills reload") {
          console.log(`${DIM}Reloading skills...${RESET}`);
          try {
            const skills = await this.client.reloadSkills();
            const loaded = skills.filter((s) => s.status === "loaded").length;
            console.log(`${GREEN}Reloaded: ${loaded}/${skills.length} skills available.${RESET}`);
          } catch (err) {
            console.log(`${RED}Reload failed: ${err instanceof Error ? err.message : String(err)}${RESET}`);
          }
          await this.handleSkills();
          continue;
        }

        if (input.startsWith("/mcp reconnect")) {
          await this.handleMcpReconnect(input.slice(14).trim());
          continue;
        }

        if (input === "/mcp") {
          await this.handleMcp();
          continue;
        }

        if (input === "/cron") {
          await this.handleCron();
          continue;
        }

        if (input === "/watchers") {
          await this.handleWatchers();
          continue;
        }

        if (input === "/agents") {
          await this.handleAgents();
          continue;
        }

        if (input.startsWith("/memory search")) {
          await this.handleMemorySearch(input.slice(14).trim());
          continue;
        }

        if (input === "/memory clear") {
          await this.handleMemoryClear(rl);
          continue;
        }

        if (input === "/memory") {
          await this.handleMemory();
          continue;
        }

        if (input === "/status") {
          await this.handleStatus();
          continue;
        }

        // Chat — 发送消息并渲染流式输出
        process.stdout.write(`${DIM}Thinking...${RESET}`);
        let firstToken = true;

        try {
          await this.client.chat(input, (event) => {
            switch (event.type) {
              case "text_delta":
                if (firstToken) {
                  process.stdout.write("\r            \r");
                  mainAgentAtLineStart = true;
                  mainAgentConsecutiveBlankLines = 0;
                  firstToken = false;
                }
                writeMainAgentText((event as { text: string }).text);
                break;

              case "tool_call": {
                if (!firstToken) {
                  process.stdout.write(RESET + "\n");
                } else {
                  process.stdout.write("\r            \r");
                }
                firstToken = true;
                mainAgentAtLineStart = true;
                mainAgentConsecutiveBlankLines = 0;
                const tc = event as { name: string; params: Record<string, unknown> };
                console.log(
                  `${MAIN_TAG}${YELLOW}> ${tc.name}(${this.formatParams(tc.params)})${RESET}`
                );
                break;
              }

              case "tool_result": {
                const tr = event as { name: string; result: { success: boolean; output: string; error?: string } };
                const status = tr.result.success
                  ? `${GREEN}ok${RESET}`
                  : `${RED}error${RESET}`;
                const output = tr.result.success
                  ? tr.result.output
                  : tr.result.error ?? "Unknown error";
                console.log(
                  `${MAIN_TAG}${DIM}  [${status}${DIM}] ${this.truncate(output)}${RESET}`
                );
                process.stdout.write(`${DIM}Thinking...${RESET}`);
                break;
              }

              case "done": {
                if (!firstToken) {
                  process.stdout.write(RESET);
                } else {
                  process.stdout.write("\r            \r");
                }
                const d = event as { usage: Record<string, unknown> };
                const usage = d.usage;
                console.log(
                  `\n${DIM}[main tokens: ${usage.totalInputTokens ?? "?"} in / ${usage.totalOutputTokens ?? "?"} out]${RESET}`
                );
                break;
              }

              case "sub_agent_start": {
                if (!firstToken) {
                  process.stdout.write(RESET + "\n");
                } else {
                  process.stdout.write("\r            \r");
                }
                firstToken = true;
                subAgentAtLineStart = true;
                const sas = event as { agentName: string; task: string };
                console.log(
                  `\n${PINK}┌── 🤖 ${BOLD}[${sas.agentName}]${RESET}${PINK} Task: ${sas.task}${RESET}`
                );
                break;
              }

              case "sub_agent_progress": {
                const sap = event as { agentName: string; innerEvent: ServerMessage };
                const inner = sap.innerEvent;
                switch (inner.type) {
                  case "text_delta":
                    writeSubAgentText(inner.text);
                    break;
                  case "tool_call":
                    console.log(
                      `${SUB_AGENT_BAR}${subTag(sap.agentName)}${YELLOW}> ${inner.name}(${this.formatParams(inner.params)})${RESET}`
                    );
                    break;
                  case "tool_result": {
                    const status = inner.result.success ? `${GREEN}ok${RESET}` : `${RED}error${RESET}`;
                    const output = inner.result.success ? inner.result.output : inner.result.error ?? "Unknown error";
                    console.log(
                      `${SUB_AGENT_BAR}${subTag(sap.agentName)}${DIM}[${status}${DIM}] ${this.truncate(output)}${RESET}`
                    );
                    break;
                  }
                  case "error":
                    console.log(
                      `${SUB_AGENT_BAR}${subTag(sap.agentName)}${RED}⚠ ${(inner as { message: string }).message}${RESET}`
                    );
                    break;
                  case "done": {
                    const d = inner as { usage?: Record<string, unknown> };
                    if (d.usage) {
                      console.log(
                        `${SUB_AGENT_BAR}${DIM}[${sap.agentName} tokens: ${d.usage.totalInputTokens ?? "?"} in / ${d.usage.totalOutputTokens ?? "?"} out]${RESET}`
                      );
                    }
                    break;
                  }
                }
                break;
              }

              case "sub_agent_done": {
                const sad = event as { agentName: string; result: string };
                console.log(
                  `${PINK}└── ✅ ${BOLD}[${sad.agentName}]${RESET}${PINK} Done: ${this.truncate(sad.result)}${RESET}\n`
                );
                mainAgentAtLineStart = true;
                mainAgentConsecutiveBlankLines = 0;
                process.stdout.write(`${DIM}Thinking...${RESET}`);
                firstToken = true;
                break;
              }
            }
          });
        } catch (err) {
          if (firstToken) {
            process.stdout.write("\r            \r");
          }
          process.stdout.write(RESET);
          console.error(
            `\n${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`
          );
        }
      }
    } finally {
      process.removeListener("SIGINT", handleSigint);
      this.client.close();
      rl.close();
    }
  }
}

// ============================================================
// Utility
// ============================================================

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

// ============================================================
// Main Entry Point
// ============================================================

export async function startCli() {
  const host = process.env.GATEWAY_HOST ?? "localhost";
  const port = process.env.GATEWAY_PORT ?? "4000";
  const url = `ws://${host}:${port}/ws`;

  console.log(`Connecting to gateway at ${url}...`);
  const client = new GatewayClient({ url });

  try {
    await client.connect();
  } catch (err) {
    console.error(`${RED}Failed to connect: ${err instanceof Error ? err.message : String(err)}${RESET}`);
    console.error(`Make sure the gateway server is running.`);
    process.exit(1);
  }

  const repl = new ClientRepl(client);
  await repl.start();
}

// 直接运行时启动 CLI
if (import.meta.main) {
  startCli();
}
