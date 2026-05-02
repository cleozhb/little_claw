import { CronExpressionParser } from "cron-parser";
import type { Database } from "../db/Database.ts";
import type { RegisteredAgent } from "./AgentRegistry.ts";

export type TeamScheduleSource = "agent_yaml" | "ui" | "migration";
export type TeamScheduleType = "cron" | "watcher";
export type TeamScheduleRunStatus = "created" | "skipped" | "failed_to_create";
export type TeamScheduleRunTriggerType = TeamScheduleType | "manual";

export interface TeamSchedule {
  id: string;
  source: TeamScheduleSource;
  sourceKey?: string;
  type: TeamScheduleType;
  name: string;
  agentName: string;
  prompt: string;
  project?: string;
  channelId?: string;
  tags: string[];
  priority: number;
  maxRetries: number;
  enabled: boolean;
  cronExpr?: string;
  checkCommand?: string;
  condition?: string;
  intervalMs?: number;
  cooldownMs?: number;
  lastRunAt?: string;
  nextRunAt?: string;
  lastCheckAt?: string;
  lastTriggeredAt?: string;
  lastTaskId?: string;
  lastStatus?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamScheduleRun {
  id: string;
  scheduleId: string;
  triggerType: TeamScheduleRunTriggerType;
  taskId?: string;
  agentName: string;
  status: TeamScheduleRunStatus;
  triggerPayload?: unknown;
  error?: string;
  createdAt: string;
}

export interface TeamScheduleFilter {
  type?: TeamScheduleType;
  agentName?: string;
  project?: string;
  enabled?: boolean;
  limit?: number;
}

export interface TeamScheduleRunFilter {
  scheduleId?: string;
  limit?: number;
}

export interface CreateTeamScheduleParams {
  source?: TeamScheduleSource;
  sourceKey?: string;
  type: TeamScheduleType;
  name: string;
  agentName: string;
  prompt: string;
  project?: string;
  channelId?: string;
  tags?: string[];
  priority?: number;
  maxRetries?: number;
  enabled?: boolean;
  cronExpr?: string;
  checkCommand?: string;
  condition?: string;
  intervalMs?: number;
  cooldownMs?: number;
}

export type UpdateTeamScheduleParams = Partial<
  Pick<
    CreateTeamScheduleParams,
    | "name"
    | "agentName"
    | "prompt"
    | "project"
    | "channelId"
    | "tags"
    | "priority"
    | "maxRetries"
    | "enabled"
    | "cronExpr"
    | "checkCommand"
    | "condition"
    | "intervalMs"
    | "cooldownMs"
  >
>;

export interface RecordTeamScheduleRunParams {
  scheduleId: string;
  triggerType: TeamScheduleRunTriggerType;
  agentName: string;
  status: TeamScheduleRunStatus;
  taskId?: string;
  triggerPayload?: unknown;
  error?: string;
}

export interface SyncTeamSchedulesResult {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

type TeamScheduleUpdatedHandler = (schedule: TeamSchedule) => void;

interface TeamScheduleRow {
  id: string;
  source: TeamScheduleSource;
  source_key: string | null;
  type: TeamScheduleType;
  name: string;
  agent_name: string;
  prompt: string;
  project: string | null;
  channel_id: string | null;
  tags: string;
  priority: number;
  max_retries: number;
  enabled: number;
  cron_expr: string | null;
  check_command: string | null;
  condition: string | null;
  interval_ms: number | null;
  cooldown_ms: number | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_check_at: string | null;
  last_triggered_at: string | null;
  last_task_id: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface TeamScheduleRunRow {
  id: string;
  schedule_id: string;
  trigger_type: TeamScheduleRunTriggerType;
  task_id: string | null;
  agent_name: string;
  status: TeamScheduleRunStatus;
  trigger_payload: string | null;
  error: string | null;
  created_at: string;
}

export class TeamScheduleStore {
  private db: Database;
  private updatedHandlers = new Set<TeamScheduleUpdatedHandler>();

  private stmtInsertSchedule;
  private stmtUpdateSchedule;
  private stmtGetSchedule;
  private stmtGetScheduleBySource;
  private stmtListSchedules;
  private stmtDeleteSchedule;
  private stmtInsertRun;
  private stmtListRuns;
  private stmtUpdateScheduleRunState;
  private stmtUpdateScheduleCheckState;

  constructor(db: Database) {
    this.db = db;
    this.initTables();

    const sqlite = this.getSQLite();
    this.stmtInsertSchedule = sqlite.prepare(`
      INSERT INTO team_schedules (
        id, source, source_key, type, name, agent_name, prompt, project, channel_id,
        tags, priority, max_retries, enabled, cron_expr, check_command, condition,
        interval_ms, cooldown_ms, last_run_at, next_run_at, last_check_at,
        last_triggered_at, last_task_id, last_status, last_error, created_at, updated_at
      )
      VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
        ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27
      )
    `);
    this.stmtUpdateSchedule = sqlite.prepare(`
      UPDATE team_schedules SET
        source = ?2,
        source_key = ?3,
        type = ?4,
        name = ?5,
        agent_name = ?6,
        prompt = ?7,
        project = ?8,
        channel_id = ?9,
        tags = ?10,
        priority = ?11,
        max_retries = ?12,
        enabled = ?13,
        cron_expr = ?14,
        check_command = ?15,
        condition = ?16,
        interval_ms = ?17,
        cooldown_ms = ?18,
        last_run_at = ?19,
        next_run_at = ?20,
        last_check_at = ?21,
        last_triggered_at = ?22,
        last_task_id = ?23,
        last_status = ?24,
        last_error = ?25,
        created_at = ?26,
        updated_at = ?27
      WHERE id = ?1
    `);
    this.stmtGetSchedule = sqlite.prepare(`SELECT * FROM team_schedules WHERE id = ?1`);
    this.stmtGetScheduleBySource = sqlite.prepare(`
      SELECT * FROM team_schedules
      WHERE source = ?1 AND source_key = ?2
      LIMIT 1
    `);
    this.stmtListSchedules = sqlite.prepare(
      `SELECT * FROM team_schedules ORDER BY enabled DESC, next_run_at IS NULL, next_run_at ASC, created_at ASC`,
    );
    this.stmtDeleteSchedule = sqlite.prepare(`DELETE FROM team_schedules WHERE id = ?1`);
    this.stmtInsertRun = sqlite.prepare(`
      INSERT INTO team_schedule_runs (
        id, schedule_id, trigger_type, task_id, agent_name, status, trigger_payload, error, created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `);
    this.stmtListRuns = sqlite.prepare(
      `SELECT * FROM team_schedule_runs ORDER BY created_at DESC`,
    );
    this.stmtUpdateScheduleRunState = sqlite.prepare(`
      UPDATE team_schedules
      SET last_run_at = ?2,
          next_run_at = ?3,
          last_triggered_at = ?4,
          last_task_id = ?5,
          last_status = ?6,
          last_error = ?7,
          updated_at = ?8
      WHERE id = ?1
    `);
    this.stmtUpdateScheduleCheckState = sqlite.prepare(`
      UPDATE team_schedules
      SET last_check_at = ?2,
          updated_at = ?3
      WHERE id = ?1
    `);
  }

  onScheduleUpdated(handler: TeamScheduleUpdatedHandler): () => void {
    this.updatedHandlers.add(handler);
    return () => this.updatedHandlers.delete(handler);
  }

  syncFromAgents(agents: RegisteredAgent[]): SyncTeamSchedulesResult {
    const result: SyncTeamSchedulesResult = { created: 0, updated: 0, unchanged: 0, deleted: 0 };
    const seenSourceKeys = new Set<string>();

    for (const agent of agents) {
      const cronJobs = agent.config.cron_jobs ?? [];
      for (let index = 0; index < cronJobs.length; index++) {
        const job = cronJobs[index]!;
        const sourceKey = yamlSourceKey(agent.config.name, "cron", job.key, index, `${job.cron}\n${job.prompt}`);
        seenSourceKeys.add(sourceKey);
        const params: CreateTeamScheduleParams = {
          source: "agent_yaml",
          sourceKey,
          type: "cron",
          name: job.name ?? `Scheduled task ${index + 1}`,
          agentName: agent.config.name,
          prompt: job.prompt,
          project: job.project ?? agent.config.default_project,
          channelId: job.channel_id,
          tags: job.tags ?? ["scheduled"],
          priority: job.priority ?? 0,
          maxRetries: job.max_retries ?? 2,
          enabled: job.enabled ?? true,
          cronExpr: job.cron,
        };
        this.upsertSyncedSchedule(params, result);
      }

      const watchers = agent.config.watchers ?? [];
      for (let index = 0; index < watchers.length; index++) {
        const watcher = watchers[index]!;
        const sourceKey = yamlSourceKey(
          agent.config.name,
          "watcher",
          watcher.key,
          index,
          `${watcher.check_command}\n${watcher.prompt}`,
        );
        seenSourceKeys.add(sourceKey);
        const params: CreateTeamScheduleParams = {
          source: "agent_yaml",
          sourceKey,
          type: "watcher",
          name: watcher.name ?? `Watcher ${index + 1}`,
          agentName: agent.config.name,
          prompt: watcher.prompt,
          project: watcher.project ?? agent.config.default_project,
          channelId: watcher.channel_id,
          tags: watcher.tags ?? ["scheduled", "watcher"],
          priority: watcher.priority ?? 0,
          maxRetries: watcher.max_retries ?? 2,
          enabled: watcher.enabled ?? true,
          checkCommand: watcher.check_command,
          condition: watcher.condition,
          intervalMs: (watcher.interval_minutes ?? 1) * 60_000,
          cooldownMs: (watcher.cooldown_minutes ?? 5) * 60_000,
        };
        this.upsertSyncedSchedule(params, result);
      }
    }

    for (const schedule of this.listSchedules()) {
      if (schedule.source !== "agent_yaml") continue;
      if (!schedule.sourceKey || seenSourceKeys.has(schedule.sourceKey)) continue;
      this.deleteSchedule(schedule.id);
      result.deleted += 1;
    }

    return result;
  }

  createSchedule(params: CreateTeamScheduleParams): TeamSchedule {
    const now = new Date().toISOString();
    const schedule = this.normalizeSchedule({
      id: crypto.randomUUID(),
      source: params.source ?? "ui",
      sourceKey: params.sourceKey,
      type: params.type,
      name: params.name,
      agentName: params.agentName,
      prompt: params.prompt,
      project: params.project,
      channelId: params.channelId,
      tags: params.tags ?? [],
      priority: params.priority ?? 0,
      maxRetries: params.maxRetries ?? 2,
      enabled: params.enabled ?? true,
      cronExpr: params.cronExpr,
      checkCommand: params.checkCommand,
      condition: params.condition,
      intervalMs: params.intervalMs,
      cooldownMs: params.cooldownMs,
      createdAt: now,
      updatedAt: now,
    });

    this.stmtInsertSchedule.run(...this.scheduleParams(schedule));
    this.emitUpdated(schedule);
    return schedule;
  }

  updateSchedule(id: string, updates: UpdateTeamScheduleParams): TeamSchedule | null {
    const current = this.getSchedule(id);
    if (!current) return null;

    const schedule = this.normalizeSchedule({
      ...current,
      ...updates,
      nextRunAt: updates.cronExpr !== undefined ? undefined : current.nextRunAt,
      updatedAt: new Date().toISOString(),
    });
    this.stmtUpdateSchedule.run(...this.scheduleParams(schedule));
    this.emitUpdated(schedule);
    return schedule;
  }

  deleteSchedule(id: string): void {
    this.stmtDeleteSchedule.run(id);
  }

  getSchedule(id: string): TeamSchedule | null {
    const row = this.stmtGetSchedule.get(id) as TeamScheduleRow | undefined;
    return row ? this.rowToSchedule(row) : null;
  }

  getScheduleBySource(source: TeamScheduleSource, sourceKey: string): TeamSchedule | null {
    const row = this.stmtGetScheduleBySource.get(source, sourceKey) as TeamScheduleRow | undefined;
    return row ? this.rowToSchedule(row) : null;
  }

  listSchedules(filter: TeamScheduleFilter = {}): TeamSchedule[] {
    let schedules = (this.stmtListSchedules.all() as TeamScheduleRow[]).map((row) => this.rowToSchedule(row));

    if (filter.type) schedules = schedules.filter((schedule) => schedule.type === filter.type);
    if (filter.agentName) schedules = schedules.filter((schedule) => schedule.agentName === filter.agentName);
    if (filter.project) schedules = schedules.filter((schedule) => schedule.project === filter.project);
    if (filter.enabled !== undefined) schedules = schedules.filter((schedule) => schedule.enabled === filter.enabled);

    return schedules.slice(0, filter.limit ?? schedules.length);
  }

  listRuns(filter: TeamScheduleRunFilter = {}): TeamScheduleRun[] {
    let runs = (this.stmtListRuns.all() as TeamScheduleRunRow[]).map((row) => this.rowToRun(row));
    if (filter.scheduleId) runs = runs.filter((run) => run.scheduleId === filter.scheduleId);
    return runs.slice(0, filter.limit ?? runs.length);
  }

  recordRun(params: RecordTeamScheduleRunParams): TeamScheduleRun {
    const now = new Date().toISOString();
    const run: TeamScheduleRun = {
      id: crypto.randomUUID(),
      scheduleId: params.scheduleId,
      triggerType: params.triggerType,
      taskId: params.taskId,
      agentName: params.agentName,
      status: params.status,
      triggerPayload: params.triggerPayload,
      error: params.error,
      createdAt: now,
    };

    this.stmtInsertRun.run(
      run.id,
      run.scheduleId,
      run.triggerType,
      run.taskId ?? null,
      run.agentName,
      run.status,
      run.triggerPayload === undefined ? null : JSON.stringify(run.triggerPayload),
      run.error ?? null,
      run.createdAt,
    );

    const schedule = this.getSchedule(run.scheduleId);
    if (schedule) {
      const nextRunAt = schedule.type === "cron" && schedule.cronExpr
        ? this.safeNextRun(schedule.cronExpr, new Date(now))
        : schedule.nextRunAt;
      this.stmtUpdateScheduleRunState.run(
        schedule.id,
        now,
        nextRunAt,
        now,
        run.taskId ?? schedule.lastTaskId ?? null,
        run.status,
        run.error ?? null,
        now,
      );
      const updated = this.getSchedule(schedule.id);
      if (updated) this.emitUpdated(updated);
    }

    return run;
  }

  markChecked(scheduleId: string, checkedAt = new Date().toISOString()): TeamSchedule | null {
    this.stmtUpdateScheduleCheckState.run(scheduleId, checkedAt, checkedAt);
    const updated = this.getSchedule(scheduleId);
    if (updated) this.emitUpdated(updated);
    return updated;
  }

  markTriggered(scheduleId: string, triggeredAt = new Date().toISOString()): TeamSchedule | null {
    const schedule = this.getSchedule(scheduleId);
    if (!schedule) return null;
    const nextRunAt = schedule.type === "cron" && schedule.cronExpr
      ? this.safeNextRun(schedule.cronExpr, new Date(triggeredAt))
      : schedule.nextRunAt;
    this.stmtUpdateScheduleRunState.run(
      schedule.id,
      triggeredAt,
      nextRunAt,
      triggeredAt,
      schedule.lastTaskId ?? null,
      schedule.lastStatus ?? null,
      schedule.lastError ?? null,
      triggeredAt,
    );
    const updated = this.getSchedule(scheduleId);
    if (updated) this.emitUpdated(updated);
    return updated;
  }

  private upsertSyncedSchedule(params: CreateTeamScheduleParams, result: SyncTeamSchedulesResult): void {
    if (!params.sourceKey) {
      throw new Error("Synced schedule requires sourceKey.");
    }
    const existing = this.getScheduleBySource(params.source ?? "agent_yaml", params.sourceKey);
    if (!existing) {
      this.createSchedule(params);
      result.created += 1;
      return;
    }

    const merged = this.normalizeSchedule({
      ...existing,
      type: params.type,
      name: params.name,
      agentName: params.agentName,
      prompt: params.prompt,
      project: params.project,
      channelId: params.channelId,
      tags: params.tags ?? [],
      priority: params.priority ?? 0,
      maxRetries: params.maxRetries ?? 2,
      enabled: params.enabled ?? existing.enabled,
      cronExpr: params.cronExpr,
      checkCommand: params.checkCommand,
      condition: params.condition,
      intervalMs: params.intervalMs,
      cooldownMs: params.cooldownMs,
      nextRunAt: existing.cronExpr !== params.cronExpr ? undefined : existing.nextRunAt,
      updatedAt: new Date().toISOString(),
    });

    if (schedulesEquivalent(existing, merged)) {
      result.unchanged += 1;
      return;
    }

    this.stmtUpdateSchedule.run(...this.scheduleParams(merged));
    this.emitUpdated(merged);
    result.updated += 1;
  }

  private normalizeSchedule(schedule: TeamSchedule): TeamSchedule {
    const name = schedule.name.trim();
    if (!name) throw new Error("Team schedule name must not be empty.");
    const agentName = schedule.agentName.trim();
    if (!agentName) throw new Error("Team schedule agentName must not be empty.");
    const prompt = schedule.prompt.trim();
    if (!prompt) throw new Error("Team schedule prompt must not be empty.");

    if (schedule.type === "cron") {
      if (!schedule.cronExpr?.trim()) {
        throw new Error("Cron team schedule requires cronExpr.");
      }
      const cronExpr = schedule.cronExpr.trim();
      return {
        ...schedule,
        name,
        agentName,
        prompt,
        cronExpr,
        checkCommand: undefined,
        condition: undefined,
        intervalMs: undefined,
        cooldownMs: undefined,
        nextRunAt: schedule.nextRunAt ?? this.safeNextRun(cronExpr),
      };
    }

    if (!schedule.checkCommand?.trim()) {
      throw new Error("Watcher team schedule requires checkCommand.");
    }
    return {
      ...schedule,
      name,
      agentName,
      prompt,
      cronExpr: undefined,
      nextRunAt: undefined,
      checkCommand: schedule.checkCommand.trim(),
      condition: schedule.condition?.trim() || undefined,
      intervalMs: schedule.intervalMs ?? 60_000,
      cooldownMs: schedule.cooldownMs ?? 300_000,
    };
  }

  private safeNextRun(cronExpr: string, from?: Date): string {
    const expr = CronExpressionParser.parse(cronExpr, {
      currentDate: from ?? new Date(),
    });
    return expr.next().toDate().toISOString();
  }

  private scheduleParams(schedule: TeamSchedule): unknown[] {
    return [
      schedule.id,
      schedule.source,
      schedule.sourceKey ?? null,
      schedule.type,
      schedule.name,
      schedule.agentName,
      schedule.prompt,
      schedule.project ?? null,
      schedule.channelId ?? null,
      JSON.stringify(schedule.tags),
      schedule.priority,
      schedule.maxRetries,
      schedule.enabled ? 1 : 0,
      schedule.cronExpr ?? null,
      schedule.checkCommand ?? null,
      schedule.condition ?? null,
      schedule.intervalMs ?? null,
      schedule.cooldownMs ?? null,
      schedule.lastRunAt ?? null,
      schedule.nextRunAt ?? null,
      schedule.lastCheckAt ?? null,
      schedule.lastTriggeredAt ?? null,
      schedule.lastTaskId ?? null,
      schedule.lastStatus ?? null,
      schedule.lastError ?? null,
      schedule.createdAt,
      schedule.updatedAt,
    ];
  }

  private rowToSchedule(row: TeamScheduleRow): TeamSchedule {
    return {
      id: row.id,
      source: row.source,
      sourceKey: row.source_key ?? undefined,
      type: row.type,
      name: row.name,
      agentName: row.agent_name,
      prompt: row.prompt,
      project: row.project ?? undefined,
      channelId: row.channel_id ?? undefined,
      tags: parseStringArray(row.tags),
      priority: row.priority,
      maxRetries: row.max_retries,
      enabled: row.enabled === 1,
      cronExpr: row.cron_expr ?? undefined,
      checkCommand: row.check_command ?? undefined,
      condition: row.condition ?? undefined,
      intervalMs: row.interval_ms ?? undefined,
      cooldownMs: row.cooldown_ms ?? undefined,
      lastRunAt: row.last_run_at ?? undefined,
      nextRunAt: row.next_run_at ?? undefined,
      lastCheckAt: row.last_check_at ?? undefined,
      lastTriggeredAt: row.last_triggered_at ?? undefined,
      lastTaskId: row.last_task_id ?? undefined,
      lastStatus: row.last_status ?? undefined,
      lastError: row.last_error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToRun(row: TeamScheduleRunRow): TeamScheduleRun {
    return {
      id: row.id,
      scheduleId: row.schedule_id,
      triggerType: row.trigger_type,
      taskId: row.task_id ?? undefined,
      agentName: row.agent_name,
      status: row.status,
      triggerPayload: row.trigger_payload ? JSON.parse(row.trigger_payload) : undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
    };
  }

  private initTables(): void {
    const sqlite = this.getSQLite();
    sqlite.run(`
      CREATE TABLE IF NOT EXISTS team_schedules (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_key TEXT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        project TEXT,
        channel_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        priority INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 2,
        enabled INTEGER NOT NULL DEFAULT 1,
        cron_expr TEXT,
        check_command TEXT,
        condition TEXT,
        interval_ms INTEGER,
        cooldown_ms INTEGER,
        last_run_at TEXT,
        next_run_at TEXT,
        last_check_at TEXT,
        last_triggered_at TEXT,
        last_task_id TEXT,
        last_status TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    sqlite.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_team_schedules_source_key
      ON team_schedules (source, source_key)
      WHERE source_key IS NOT NULL
    `);
    sqlite.run(`CREATE INDEX IF NOT EXISTS idx_team_schedules_agent ON team_schedules (agent_name)`);
    sqlite.run(`CREATE INDEX IF NOT EXISTS idx_team_schedules_enabled_type ON team_schedules (enabled, type)`);

    sqlite.run(`
      CREATE TABLE IF NOT EXISTS team_schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        task_id TEXT,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger_payload TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (schedule_id) REFERENCES team_schedules(id)
      )
    `);
    sqlite.run(`CREATE INDEX IF NOT EXISTS idx_team_schedule_runs_schedule ON team_schedule_runs (schedule_id, created_at)`);
  }

  private emitUpdated(schedule: TeamSchedule): void {
    for (const handler of this.updatedHandlers) {
      handler(schedule);
    }
  }

  private getSQLite() {
    return (this.db as any).db;
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function yamlSourceKey(
  agentName: string,
  type: TeamScheduleType,
  explicitKey: string | undefined,
  index: number,
  fallbackContent: string,
): string {
  const key = explicitKey?.trim() || `index-${index}-${hashString(fallbackContent)}`;
  return `${agentName}:${type}:${key}`;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function schedulesEquivalent(a: TeamSchedule, b: TeamSchedule): boolean {
  return (
    a.source === b.source &&
    a.sourceKey === b.sourceKey &&
    a.type === b.type &&
    a.name === b.name &&
    a.agentName === b.agentName &&
    a.prompt === b.prompt &&
    a.project === b.project &&
    a.channelId === b.channelId &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags) &&
    a.priority === b.priority &&
    a.maxRetries === b.maxRetries &&
    a.enabled === b.enabled &&
    a.cronExpr === b.cronExpr &&
    a.checkCommand === b.checkCommand &&
    a.condition === b.condition &&
    a.intervalMs === b.intervalMs &&
    a.cooldownMs === b.cooldownMs
  );
}
