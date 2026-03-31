import { CronExpressionParser } from "cron-parser";
import type { Database } from "../db/Database.ts";
import type { CronJob, SchedulerEvent } from "./types.ts";

// Database row shape
interface CronJobRow {
  id: string;
  name: string;
  cron_expr: string;
  prompt: string;
  session_id: string;
  enabled: number; // 0 | 1
  created_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
}

export class CronScheduler {
  private db: Database;
  private timer: ReturnType<typeof setInterval> | null = null;
  private callbacks: Array<(event: SchedulerEvent) => void> = [];

  // Prepared statements
  private stmtInsertJob;
  private stmtDeleteJob;
  private stmtUpdateJob;
  private stmtGetJob;
  private stmtListJobs;
  private stmtListEnabled;
  private stmtUpdateRunTimes;

  constructor(db: Database) {
    this.db = db;
    this.initTable();

    const sqlite = this.getSQLite();

    this.stmtInsertJob = sqlite.prepare(
      `INSERT INTO cron_jobs (id, name, cron_expr, prompt, session_id, enabled, created_at, last_run_at, next_run_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    );

    this.stmtDeleteJob = sqlite.prepare(
      `DELETE FROM cron_jobs WHERE id = ?1`
    );

    this.stmtUpdateJob = sqlite.prepare(
      `UPDATE cron_jobs SET name = ?2, cron_expr = ?3, prompt = ?4, session_id = ?5, enabled = ?6 WHERE id = ?1`
    );

    this.stmtGetJob = sqlite.prepare(
      `SELECT * FROM cron_jobs WHERE id = ?1`
    );

    this.stmtListJobs = sqlite.prepare(
      `SELECT * FROM cron_jobs ORDER BY created_at ASC`
    );

    this.stmtListEnabled = sqlite.prepare(
      `SELECT * FROM cron_jobs WHERE enabled = 1`
    );

    this.stmtUpdateRunTimes = sqlite.prepare(
      `UPDATE cron_jobs SET last_run_at = ?2, next_run_at = ?3 WHERE id = ?1`
    );
  }

  /**
   * Access the underlying SQLite instance from Database.
   * Database doesn't expose its internal db, so we use the same
   * pattern: run raw SQL via db.run and prepare via the constructor.
   * We access the internal SQLite database through a controlled accessor.
   */
  private getSQLite() {
    // Access internal SQLite - Database wraps bun:sqlite's Database
    // We need direct access for our own prepared statements
    return (this.db as any).db;
  }

  private initTable(): void {
    const sqlite = this.getSQLite();
    sqlite.run(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        cron_expr    TEXT NOT NULL,
        prompt       TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL,
        last_run_at  TEXT,
        next_run_at  TEXT
      )
    `);
  }

  // --- Row <-> CronJob conversion ---

  private rowToJob(row: CronJobRow): CronJob {
    return {
      id: row.id,
      name: row.name,
      cronExpr: row.cron_expr,
      prompt: row.prompt,
      sessionId: row.session_id,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastRunAt: row.last_run_at ?? undefined,
      nextRunAt: row.next_run_at ?? undefined,
    };
  }

  // --- Cron expression helpers ---

  /**
   * 计算 cron 表达式的下次执行时间
   */
  getNextRun(cronExpr: string, from?: Date): Date {
    const expr = CronExpressionParser.parse(cronExpr, {
      currentDate: from ?? new Date(),
    });
    return expr.next().toDate();
  }

  /**
   * 判断当前时间（精确到分钟）是否匹配 cron 表达式
   */
  private isTimeMatching(cronExpr: string, now: Date): boolean {
    const startOfMinute = new Date(now);
    startOfMinute.setSeconds(0, 0);

    const justBefore = new Date(startOfMinute.getTime() - 1000);
    const expr = CronExpressionParser.parse(cronExpr, { currentDate: justBefore });
    const nextDate = expr.next().toDate();

    return nextDate.getTime() === startOfMinute.getTime();
  }

  // --- Job CRUD ---

  addJob(job: Omit<CronJob, "id" | "createdAt" | "lastRunAt" | "nextRunAt">): CronJob {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const nextRunAt = this.getNextRun(job.cronExpr).toISOString();

    this.stmtInsertJob.run(
      id,
      job.name,
      job.cronExpr,
      job.prompt,
      job.sessionId,
      job.enabled ? 1 : 0,
      now,
      null,
      nextRunAt
    );

    return {
      id,
      name: job.name,
      cronExpr: job.cronExpr,
      prompt: job.prompt,
      sessionId: job.sessionId,
      enabled: job.enabled,
      createdAt: now,
      nextRunAt,
    };
  }

  removeJob(id: string): void {
    this.stmtDeleteJob.run(id);
  }

  updateJob(id: string, updates: Partial<Pick<CronJob, "name" | "cronExpr" | "prompt" | "sessionId" | "enabled">>): CronJob | null {
    const row = this.stmtGetJob.get(id) as CronJobRow | undefined;
    if (!row) return null;

    const updated = {
      name: updates.name ?? row.name,
      cronExpr: updates.cronExpr ?? row.cron_expr,
      prompt: updates.prompt ?? row.prompt,
      sessionId: updates.sessionId ?? row.session_id,
      enabled: updates.enabled ?? (row.enabled === 1),
    };

    this.stmtUpdateJob.run(
      id,
      updated.name,
      updated.cronExpr,
      updated.prompt,
      updated.sessionId,
      updated.enabled ? 1 : 0
    );

    // Recalculate next run if cron expression changed
    if (updates.cronExpr) {
      const nextRunAt = this.getNextRun(updated.cronExpr).toISOString();
      this.stmtUpdateRunTimes.run(id, row.last_run_at, nextRunAt);
    }

    // Re-fetch the updated row
    const newRow = this.stmtGetJob.get(id) as CronJobRow;
    return this.rowToJob(newRow);
  }

  listJobs(): CronJob[] {
    const rows = this.stmtListJobs.all() as CronJobRow[];
    return rows.map((row) => this.rowToJob(row));
  }

  // --- Event system (观察者模式) ---
  // callbacks 数组 = 观察者列表
  // onTrigger()  = subscribe，外部注册回调
  // emit()       = notify，遍历回调通知所有观察者

  onTrigger(callback: (event: SchedulerEvent) => void): void {
    this.callbacks.push(callback);
  }

  private emit(event: SchedulerEvent): void {
    for (const cb of this.callbacks) {
      try {
        cb(event);
      } catch (err) {
        console.error("[CronScheduler] Error in trigger callback:", err);
      }
    }
  }

  // --- Scheduler lifecycle ---

  /**
   * 启动调度器，每 60 秒检查一次
   */
  start(): void {
    if (this.timer) return;

    console.log("[CronScheduler] Started (checking every 60s)");

    // Run an initial check immediately
    this.tick();

    this.timer = setInterval(() => {
      this.tick();
    }, 60_000);
  }

  /**
   * 停止调度器
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[CronScheduler] Stopped");
    }
  }

  /**
   * 单次 tick：检查所有 enabled job 是否需要触发
   */
  private tick(): void {
    const now = new Date();
    const rows = this.stmtListEnabled.all() as CronJobRow[];

    for (const row of rows) {
      try {
        if (this.isTimeMatching(row.cron_expr, now)) {
          const job = this.rowToJob(row);

          // Update run times
          const lastRunAt = now.toISOString();
          const nextRunAt = this.getNextRun(row.cron_expr, now).toISOString();
          this.stmtUpdateRunTimes.run(row.id, lastRunAt, nextRunAt);

          // Update job object before emitting
          job.lastRunAt = lastRunAt;
          job.nextRunAt = nextRunAt;

          console.log(`[CronScheduler] Triggered job "${job.name}" (${job.id})`);
          this.emit({ type: "cron_trigger", job });
        }
      } catch (err) {
        console.error(`[CronScheduler] Error processing job ${row.id}:`, err);
      }
    }
  }
}
