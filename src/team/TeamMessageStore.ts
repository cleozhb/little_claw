import type { Database } from "../db/Database.ts";

export type TeamChannelType = "project" | "agent_dm" | "coordinator" | "system";
export type TeamSenderType = "human" | "agent" | "coordinator" | "system";
export type TeamMessagePriority = "low" | "normal" | "high" | "urgent";
export type TeamMessageStatus = "new" | "routed" | "acked" | "injected" | "resolved";

export interface TeamMessage {
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

export interface CreateTeamMessageParams {
  channelType: TeamChannelType;
  channelId: string;
  project?: string;
  taskId?: string;
  senderType: TeamSenderType;
  senderId: string;
  content: string;
  priority?: TeamMessagePriority;
  status?: TeamMessageStatus;
  handledBy?: string;
  externalChannel?: string;
  externalChatId?: string;
  externalMessageId?: string;
}

export interface ListTeamMessagesFilter {
  channelType?: TeamChannelType;
  channelId?: string;
  project?: string;
  taskId?: string;
  senderId?: string;
  status?: TeamMessageStatus;
  statuses?: TeamMessageStatus[];
  limit?: number;
}

export interface RouteTeamMessageParams {
  channelType: TeamChannelType;
  channelId: string;
  project?: string;
  taskId?: string;
  routedBy?: string;
}

type TeamMessageCreatedHandler = (message: TeamMessage) => void;

interface TeamMessageRow {
  id: string;
  channel_type: TeamChannelType;
  channel_id: string;
  project: string | null;
  task_id: string | null;
  sender_type: TeamSenderType;
  sender_id: string;
  content: string;
  priority: TeamMessagePriority;
  status: TeamMessageStatus;
  handled_by: string | null;
  external_channel: string | null;
  external_chat_id: string | null;
  external_message_id: string | null;
  created_at: string;
  handled_at: string | null;
}

const PENDING_STATUSES: TeamMessageStatus[] = ["new", "routed", "acked"];

/**
 * 团队消息存储。
 *
 * 负责保存人类、Agent、Coordinator、系统之间的沟通事实记录。
 * 它只处理消息本身的持久化、去重、状态标记和 pending 查询；
 * 不负责修改任务状态，任务状态仍由 TaskQueue 和 task_logs 管理。
 */
export class TeamMessageStore {
  private db: Database;
  private createdHandlers = new Set<TeamMessageCreatedHandler>();

  private stmtInsertMessage;
  private stmtGetMessage;
  private stmtGetByExternalMessage;
  private stmtListMessages;
  private stmtUpdateStatus;
  private stmtUpdateRoute;

  constructor(db: Database) {
    this.db = db;
    initTeamMessageTables(db);

    const sqlite = this.getSQLite();
    this.stmtInsertMessage = sqlite.prepare(`
      INSERT INTO team_messages (
        id, channel_type, channel_id, project, task_id, sender_type, sender_id,
        content, priority, status, handled_by, external_channel, external_chat_id,
        external_message_id, created_at, handled_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    `);
    this.stmtGetMessage = sqlite.prepare(`SELECT * FROM team_messages WHERE id = ?1`);
    this.stmtGetByExternalMessage = sqlite.prepare(`
      SELECT * FROM team_messages
      WHERE external_channel = ?1 AND external_message_id = ?2
      LIMIT 1
    `);
    this.stmtListMessages = sqlite.prepare(
      `SELECT * FROM team_messages ORDER BY created_at ASC`,
    );
    this.stmtUpdateStatus = sqlite.prepare(`
      UPDATE team_messages
      SET status = ?2, handled_by = ?3, handled_at = ?4
      WHERE id = ?1
    `);
    this.stmtUpdateRoute = sqlite.prepare(`
      UPDATE team_messages
      SET channel_type = ?2,
          channel_id = ?3,
          project = ?4,
          task_id = ?5,
          status = 'routed',
          handled_by = ?6
      WHERE id = ?1
    `);
  }

  createMessage(params: CreateTeamMessageParams): TeamMessage {
    this.assertContent(params.content);

    // 飞书等外部渠道可能重试同一事件；同一 external_channel + external_message_id 只保留一条事实记录。
    const existing = this.getByExternalMessage(params.externalChannel, params.externalMessageId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const message: TeamMessage = {
      id: crypto.randomUUID(),
      channelType: params.channelType,
      channelId: params.channelId,
      project: params.project,
      taskId: params.taskId,
      senderType: params.senderType,
      senderId: params.senderId,
      content: params.content,
      priority: params.priority ?? "normal",
      status: params.status ?? "new",
      handledBy: params.handledBy,
      externalChannel: params.externalChannel,
      externalChatId: params.externalChatId,
      externalMessageId: params.externalMessageId,
      createdAt: now,
      handledAt: params.status && params.status !== "new" ? now : undefined,
    };

    try {
      this.stmtInsertMessage.run(
        message.id,
        message.channelType,
        message.channelId,
        message.project ?? null,
        message.taskId ?? null,
        message.senderType,
        message.senderId,
        message.content,
        message.priority,
        message.status,
        message.handledBy ?? null,
        message.externalChannel ?? null,
        message.externalChatId ?? null,
        message.externalMessageId ?? null,
        message.createdAt,
        message.handledAt ?? null,
      );
      this.emitCreated(message);
      return message;
    } catch (err) {
      const deduped = this.getByExternalMessage(params.externalChannel, params.externalMessageId);
      if (deduped) return deduped;
      throw err;
    }
  }

  getMessage(id: string): TeamMessage | null {
    const row = this.stmtGetMessage.get(id) as TeamMessageRow | undefined;
    return row ? this.rowToMessage(row) : null;
  }

  onMessageCreated(handler: TeamMessageCreatedHandler): () => void {
    this.createdHandlers.add(handler);
    return () => {
      this.createdHandlers.delete(handler);
    };
  }

  listMessages(filter: ListTeamMessagesFilter = {}): TeamMessage[] {
    let messages = (this.stmtListMessages.all() as TeamMessageRow[]).map((row) =>
      this.rowToMessage(row),
    );

    if (filter.channelType) {
      messages = messages.filter((message) => message.channelType === filter.channelType);
    }
    if (filter.channelId) {
      messages = messages.filter((message) => message.channelId === filter.channelId);
    }
    if (filter.project) {
      messages = messages.filter((message) => message.project === filter.project);
    }
    if (filter.taskId) {
      messages = messages.filter((message) => message.taskId === filter.taskId);
    }
    if (filter.senderId) {
      messages = messages.filter((message) => message.senderId === filter.senderId);
    }
    if (filter.status) {
      messages = messages.filter((message) => message.status === filter.status);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      const statuses = new Set(filter.statuses);
      messages = messages.filter((message) => statuses.has(message.status));
    }

    return messages.slice(0, filter.limit ?? messages.length);
  }

  markRouted(id: string, routedBy?: string): TeamMessage {
    return this.markStatus(id, "routed", routedBy, false);
  }

  /**
   * TeamRouter 使用的原地改路由入口。
   *
   * 人类消息必须先写入事实表，再根据确定性规则补齐最终 channel/project/task，
   * 这样外部平台重试时仍能靠 external_message_id 去重，避免重复执行控制命令。
   */
  routeMessage(id: string, params: RouteTeamMessageParams): TeamMessage {
    this.requireMessage(id);
    this.stmtUpdateRoute.run(
      id,
      params.channelType,
      params.channelId,
      params.project ?? null,
      params.taskId ?? null,
      params.routedBy ?? "team-router",
    );
    return this.requireMessage(id);
  }

  markAcked(id: string, ackedBy?: string): TeamMessage {
    return this.markStatus(id, "acked", ackedBy, false);
  }

  markInjected(id: string, injectedBy: string): TeamMessage {
    // injected 表示消息已经进入某个 Agent 的运行上下文，后续不能再次注入。
    return this.markStatus(id, "injected", injectedBy, true);
  }

  markResolved(id: string, resolvedBy: string): TeamMessage {
    return this.markStatus(id, "resolved", resolvedBy, true);
  }

  getPendingForAgent(agentName: string, limit = 20): TeamMessage[] {
    return this.listMessages({
      channelType: "agent_dm",
      channelId: agentName,
      statuses: PENDING_STATUSES,
      limit,
    });
  }

  getPendingForProject(project: string, limit = 50): TeamMessage[] {
    return this.listMessages({
      channelType: "project",
      statuses: PENDING_STATUSES,
    })
      .filter((message) => message.project === project)
      .slice(0, limit);
  }

  getPendingForTask(taskId: string, limit = 20): TeamMessage[] {
    return this.listMessages({
      taskId,
      statuses: PENDING_STATUSES,
      limit,
    });
  }

  private markStatus(
    id: string,
    status: TeamMessageStatus,
    handledBy: string | undefined,
    handled: boolean,
  ): TeamMessage {
    const message = this.requireMessage(id);
    const handledAt = handled ? new Date().toISOString() : message.handledAt;
    this.stmtUpdateStatus.run(id, status, handledBy ?? message.handledBy ?? null, handledAt ?? null);
    return this.requireMessage(id);
  }

  private getByExternalMessage(
    externalChannel: string | undefined,
    externalMessageId: string | undefined,
  ): TeamMessage | null {
    if (!externalChannel || !externalMessageId) return null;
    const row = this.stmtGetByExternalMessage.get(
      externalChannel,
      externalMessageId,
    ) as TeamMessageRow | undefined;
    return row ? this.rowToMessage(row) : null;
  }

  private requireMessage(id: string): TeamMessage {
    const message = this.getMessage(id);
    if (!message) {
      throw new Error(`Team message not found: ${id}`);
    }
    return message;
  }

  private rowToMessage(row: TeamMessageRow): TeamMessage {
    return {
      id: row.id,
      channelType: row.channel_type,
      channelId: row.channel_id,
      project: row.project ?? undefined,
      taskId: row.task_id ?? undefined,
      senderType: row.sender_type,
      senderId: row.sender_id,
      content: row.content,
      priority: row.priority,
      status: row.status,
      handledBy: row.handled_by ?? undefined,
      externalChannel: row.external_channel ?? undefined,
      externalChatId: row.external_chat_id ?? undefined,
      externalMessageId: row.external_message_id ?? undefined,
      createdAt: row.created_at,
      handledAt: row.handled_at ?? undefined,
    };
  }

  private assertContent(content: string): void {
    if (content.trim() === "") {
      throw new Error("Team message content must not be empty.");
    }
  }

  private emitCreated(message: TeamMessage): void {
    if (message.senderType === "human") return;
    for (const handler of this.createdHandlers) {
      handler(message);
    }
  }

  private getSQLite() {
    return (this.db as any).db;
  }
}

/**
 * 初始化 Lovely Octopus 团队模式需要的三张表。
 *
 * TeamMessageStore 和 ProjectChannelStore 都会调用它，因此这里必须保持幂等。
 * 这样调用方只要构造任意一个 store，就能确保项目频道、外部绑定和团队消息表都存在。
 */
export function initTeamMessageTables(db: Database): void {
  const sqlite = (db as any).db;

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS project_channels (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      context_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS external_channel_bindings (
      id TEXT PRIMARY KEY,
      external_channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(external_channel, external_chat_id)
    )
  `);

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS team_messages (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      project TEXT,
      task_id TEXT,
      sender_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'new',
      handled_by TEXT,
      external_channel TEXT,
      external_chat_id TEXT,
      external_message_id TEXT,
      created_at TEXT NOT NULL,
      handled_at TEXT
    )
  `);

  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_team_messages_channel ON team_messages (channel_type, channel_id)`);
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_team_messages_project ON team_messages (project)`);
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_team_messages_task ON team_messages (task_id)`);
  sqlite.run(`CREATE INDEX IF NOT EXISTS idx_team_messages_status ON team_messages (status)`);
  sqlite.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_messages_external_message
      ON team_messages (external_channel, external_message_id)
      WHERE external_channel IS NOT NULL AND external_message_id IS NOT NULL
  `);
}
