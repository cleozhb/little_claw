import type { Database } from "../db/Database.ts";
import {
  initTeamMessageTables,
  TeamMessageStore,
  type CreateTeamMessageParams,
  type TeamChannelType,
  type TeamMessage,
} from "./TeamMessageStore.ts";

export type ProjectChannelStatus = "active" | "paused" | "archived";

export interface ProjectChannel {
  id: string;
  slug: string;
  title: string;
  description?: string;
  status: ProjectChannelStatus;
  contextPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalChannelBinding {
  id: string;
  externalChannel: string;
  externalChatId: string;
  channelType: TeamChannelType;
  channelId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectChannelParams {
  slug: string;
  title: string;
  description?: string;
  status?: ProjectChannelStatus;
  contextPath?: string;
}

export interface BindExternalChatParams {
  externalChannel: string;
  externalChatId: string;
  channelType: TeamChannelType;
  channelId: string;
  createdBy: string;
}

interface ProjectChannelRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: ProjectChannelStatus;
  context_path: string | null;
  created_at: string;
  updated_at: string;
}

interface ExternalChannelBindingRow {
  id: string;
  external_channel: string;
  external_chat_id: string;
  channel_type: TeamChannelType;
  channel_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const CHANNEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * 项目频道存储。
 *
 * 项目频道是 little_claw 内部的虚拟频道，不依赖飞书或 Web UI 是否原生支持频道。
 * 这个类负责创建/查询项目频道、维护外部 chat 到内部频道的绑定，
 * 并提供面向项目频道的发消息和读消息入口。
 */
export class ProjectChannelStore {
  private db: Database;
  private messages: TeamMessageStore;

  private stmtInsertChannel;
  private stmtGetChannel;
  private stmtGetChannelBySlug;
  private stmtListChannels;
  private stmtInsertBinding;
  private stmtDeleteBinding;
  private stmtResolveBinding;

  constructor(db: Database, messages?: TeamMessageStore) {
    this.db = db;
    initTeamMessageTables(db);
    this.messages = messages ?? new TeamMessageStore(db);

    const sqlite = this.getSQLite();
    this.stmtInsertChannel = sqlite.prepare(`
      INSERT INTO project_channels (
        id, slug, title, description, status, context_path, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `);
    this.stmtGetChannel = sqlite.prepare(`SELECT * FROM project_channels WHERE id = ?1`);
    this.stmtGetChannelBySlug = sqlite.prepare(`SELECT * FROM project_channels WHERE slug = ?1`);
    this.stmtListChannels = sqlite.prepare(
      `SELECT * FROM project_channels ORDER BY created_at ASC`,
    );
    this.stmtInsertBinding = sqlite.prepare(`
      INSERT INTO external_channel_bindings (
        id, external_channel, external_chat_id, channel_type, channel_id,
        created_by, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(external_channel, external_chat_id) DO UPDATE SET
        channel_type = excluded.channel_type,
        channel_id = excluded.channel_id,
        created_by = excluded.created_by,
        updated_at = excluded.updated_at
    `);
    this.stmtDeleteBinding = sqlite.prepare(`
      DELETE FROM external_channel_bindings
      WHERE external_channel = ?1 AND external_chat_id = ?2
    `);
    this.stmtResolveBinding = sqlite.prepare(`
      SELECT * FROM external_channel_bindings
      WHERE external_channel = ?1 AND external_chat_id = ?2
      LIMIT 1
    `);
  }

  createChannel(params: CreateProjectChannelParams): ProjectChannel {
    this.assertValidSlug(params.slug);

    const existing = this.getChannel(params.slug);
    if (existing) return existing;

    const now = new Date().toISOString();
    const channel: ProjectChannel = {
      id: crypto.randomUUID(),
      slug: params.slug,
      title: params.title,
      description: params.description,
      status: params.status ?? "active",
      contextPath: params.contextPath,
      createdAt: now,
      updatedAt: now,
    };

    this.stmtInsertChannel.run(
      channel.id,
      channel.slug,
      channel.title,
      channel.description ?? null,
      channel.status,
      channel.contextPath ?? null,
      channel.createdAt,
      channel.updatedAt,
    );

    return channel;
  }

  getChannel(idOrSlug: string): ProjectChannel | null {
    const row =
      (this.stmtGetChannel.get(idOrSlug) as ProjectChannelRow | undefined) ??
      (this.stmtGetChannelBySlug.get(idOrSlug) as ProjectChannelRow | undefined);
    return row ? this.rowToChannel(row) : null;
  }

  listChannels(filter: { status?: ProjectChannelStatus; limit?: number } = {}): ProjectChannel[] {
    let channels = (this.stmtListChannels.all() as ProjectChannelRow[]).map((row) =>
      this.rowToChannel(row),
    );
    if (filter.status) {
      channels = channels.filter((channel) => channel.status === filter.status);
    }
    return channels.slice(0, filter.limit ?? channels.length);
  }

  bindExternalChat(params: BindExternalChatParams): ExternalChannelBinding {
    this.assertExternalBinding(params.externalChannel, params.externalChatId);
    const channelId = this.normalizeChannelTarget(params.channelType, params.channelId);

    const now = new Date().toISOString();
    this.stmtInsertBinding.run(
      crypto.randomUUID(),
      params.externalChannel,
      params.externalChatId,
      params.channelType,
      channelId,
      params.createdBy,
      now,
      now,
    );

    const binding = this.resolveExternalChat(params.externalChannel, params.externalChatId);
    if (!binding) {
      throw new Error("Failed to bind external chat.");
    }
    return binding;
  }

  unbindExternalChat(externalChannel: string, externalChatId: string): void {
    this.stmtDeleteBinding.run(externalChannel, externalChatId);
  }

  resolveExternalChat(externalChannel: string, externalChatId: string): ExternalChannelBinding | null {
    const row = this.stmtResolveBinding.get(
      externalChannel,
      externalChatId,
    ) as ExternalChannelBindingRow | undefined;
    return row ? this.rowToBinding(row) : null;
  }

  postMessage(
    channelIdOrSlug: string,
    params: Omit<CreateTeamMessageParams, "channelType" | "channelId" | "project"> & {
      taskId?: string;
    },
  ): TeamMessage {
    const channel = this.requireChannel(channelIdOrSlug);
    return this.messages.createMessage({
      ...params,
      channelType: "project",
      channelId: channel.id,
      project: channel.slug,
    });
  }

  listMessages(channelIdOrSlug: string, limit = 50): TeamMessage[] {
    const channel = this.requireChannel(channelIdOrSlug);
    return this.messages.listMessages({
      channelType: "project",
      channelId: channel.id,
      limit,
    });
  }

  private normalizeChannelTarget(channelType: TeamChannelType, channelId: string): string {
    if (channelId.trim() === "") {
      throw new Error("Binding channel_id must not be empty.");
    }
    if (channelType === "project") {
      return this.requireChannel(channelId).id;
    }
    return channelId;
  }

  private requireChannel(idOrSlug: string): ProjectChannel {
    const channel = this.getChannel(idOrSlug);
    if (!channel) {
      throw new Error(`Project channel not found: ${idOrSlug}`);
    }
    return channel;
  }

  private assertValidSlug(slug: string): void {
    if (!CHANNEL_SLUG_PATTERN.test(slug)) {
      throw new Error(
        `Invalid project channel slug "${slug}". Use lowercase letters, numbers, underscore, or hyphen, and start with a letter or number.`,
      );
    }
  }

  private assertExternalBinding(externalChannel: string, externalChatId: string): void {
    if (externalChannel.trim() === "" || externalChatId.trim() === "") {
      throw new Error("External channel and chat id must not be empty.");
    }
  }

  private rowToChannel(row: ProjectChannelRow): ProjectChannel {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status,
      contextPath: row.context_path ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToBinding(row: ExternalChannelBindingRow): ExternalChannelBinding {
    return {
      id: row.id,
      externalChannel: row.external_channel,
      externalChatId: row.external_chat_id,
      channelType: row.channel_type,
      channelId: row.channel_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getSQLite() {
    return (this.db as any).db;
  }
}
