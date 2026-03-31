import type { Database } from "../db/Database.ts";
import type { WatcherDef, SchedulerEvent } from "./types.ts";

// Database row shape
interface WatcherRow {
  id: string;
  name: string;
  check_command: string;
  condition: string;
  prompt: string;
  interval_ms: number;
  cooldown_ms: number;
  session_id: string;
  enabled: number; // 0 | 1
  created_at: string;
  last_check_at: string | null;
  last_triggered_at: string | null;
}

export class EventWatcher {
  private db: Database;
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private callbacks: Array<(event: SchedulerEvent) => void> = [];
  private running = false;

  // Prepared statements
  private stmtInsertWatcher;
  private stmtDeleteWatcher;
  private stmtUpdateWatcher;
  private stmtGetWatcher;
  private stmtListWatchers;
  private stmtListEnabled;
  private stmtUpdateCheckAt;
  private stmtUpdateTriggeredAt;

  constructor(db: Database) {
    this.db = db;
    this.initTable();

    const sqlite = this.getSQLite();

    this.stmtInsertWatcher = sqlite.prepare(
      `INSERT INTO event_watchers (id, name, check_command, condition, prompt, interval_ms, cooldown_ms, session_id, enabled, created_at, last_check_at, last_triggered_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
    );

    this.stmtDeleteWatcher = sqlite.prepare(
      `DELETE FROM event_watchers WHERE id = ?1`
    );

    this.stmtUpdateWatcher = sqlite.prepare(
      `UPDATE event_watchers SET name = ?2, check_command = ?3, condition = ?4, prompt = ?5, interval_ms = ?6, cooldown_ms = ?7, session_id = ?8, enabled = ?9 WHERE id = ?1`
    );

    this.stmtGetWatcher = sqlite.prepare(
      `SELECT * FROM event_watchers WHERE id = ?1`
    );

    this.stmtListWatchers = sqlite.prepare(
      `SELECT * FROM event_watchers ORDER BY created_at ASC`
    );

    this.stmtListEnabled = sqlite.prepare(
      `SELECT * FROM event_watchers WHERE enabled = 1`
    );

    this.stmtUpdateCheckAt = sqlite.prepare(
      `UPDATE event_watchers SET last_check_at = ?2 WHERE id = ?1`
    );

    this.stmtUpdateTriggeredAt = sqlite.prepare(
      `UPDATE event_watchers SET last_triggered_at = ?2 WHERE id = ?1`
    );
  }

  private getSQLite() {
    return (this.db as any).db;
  }

  private initTable(): void {
    const sqlite = this.getSQLite();
    sqlite.run(`
      CREATE TABLE IF NOT EXISTS event_watchers (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        check_command     TEXT NOT NULL,
        condition         TEXT NOT NULL,
        prompt            TEXT NOT NULL,
        interval_ms       INTEGER NOT NULL DEFAULT 60000,
        cooldown_ms       INTEGER NOT NULL DEFAULT 300000,
        session_id        TEXT NOT NULL,
        enabled           INTEGER NOT NULL DEFAULT 1,
        created_at        TEXT NOT NULL,
        last_check_at     TEXT,
        last_triggered_at TEXT
      )
    `);
  }

  // --- Row <-> WatcherDef conversion ---

  private rowToWatcher(row: WatcherRow): WatcherDef {
    return {
      id: row.id,
      name: row.name,
      checkCommand: row.check_command,
      condition: row.condition,
      prompt: row.prompt,
      intervalMs: row.interval_ms,
      cooldownMs: row.cooldown_ms,
      sessionId: row.session_id,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastCheckAt: row.last_check_at ?? undefined,
      lastTriggeredAt: row.last_triggered_at ?? undefined,
    };
  }

  // --- Watcher CRUD ---

  addWatcher(watcher: Omit<WatcherDef, "id" | "createdAt" | "lastCheckAt" | "lastTriggeredAt">): WatcherDef {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    this.stmtInsertWatcher.run(
      id,
      watcher.name,
      watcher.checkCommand,
      watcher.condition,
      watcher.prompt,
      watcher.intervalMs,
      watcher.cooldownMs,
      watcher.sessionId,
      watcher.enabled ? 1 : 0,
      now,
      null,
      null
    );

    const result: WatcherDef = {
      id,
      ...watcher,
      createdAt: now,
    };

    // 如果调度器已启动且 watcher 是 enabled 的，自动启动定时器
    if (this.running && watcher.enabled) {
      this.startOne(result);
    }

    return result;
  }

  removeWatcher(id: string): void {
    // Stop the timer for this watcher if running
    this.stopOne(id);
    this.stmtDeleteWatcher.run(id);
  }

  updateWatcher(id: string, updates: Partial<Pick<WatcherDef, "name" | "checkCommand" | "condition" | "prompt" | "intervalMs" | "cooldownMs" | "sessionId" | "enabled">>): WatcherDef | null {
    const row = this.stmtGetWatcher.get(id) as WatcherRow | undefined;
    if (!row) return null;

    const merged = {
      name: updates.name ?? row.name,
      checkCommand: updates.checkCommand ?? row.check_command,
      condition: updates.condition ?? row.condition,
      prompt: updates.prompt ?? row.prompt,
      intervalMs: updates.intervalMs ?? row.interval_ms,
      cooldownMs: updates.cooldownMs ?? row.cooldown_ms,
      sessionId: updates.sessionId ?? row.session_id,
      enabled: updates.enabled ?? (row.enabled === 1),
    };

    this.stmtUpdateWatcher.run(
      id,
      merged.name,
      merged.checkCommand,
      merged.condition,
      merged.prompt,
      merged.intervalMs,
      merged.cooldownMs,
      merged.sessionId,
      merged.enabled ? 1 : 0
    );

    // If the watcher is running and interval changed, restart it
    if (updates.intervalMs !== undefined && this.timers.has(id)) {
      this.stopOne(id);
      if (merged.enabled) {
        const newRow = this.stmtGetWatcher.get(id) as WatcherRow;
        this.startOne(this.rowToWatcher(newRow));
      }
    }

    // If enabled state changed, start/stop accordingly
    if (updates.enabled !== undefined) {
      if (merged.enabled && !this.timers.has(id)) {
        const newRow = this.stmtGetWatcher.get(id) as WatcherRow;
        this.startOne(this.rowToWatcher(newRow));
      } else if (!merged.enabled) {
        this.stopOne(id);
      }
    }

    const newRow = this.stmtGetWatcher.get(id) as WatcherRow;
    return this.rowToWatcher(newRow);
  }

  listWatchers(): WatcherDef[] {
    const rows = this.stmtListWatchers.all() as WatcherRow[];
    return rows.map((row) => this.rowToWatcher(row));
  }

  // --- Event system ---

  onTrigger(callback: (event: SchedulerEvent) => void): void {
    this.callbacks.push(callback);
  }

  private emit(event: SchedulerEvent): void {
    for (const cb of this.callbacks) {
      try {
        cb(event);
      } catch (err) {
        console.error("[EventWatcher] Error in trigger callback:", err);
      }
    }
  }

  // --- Check logic ---

  /**
   * 执行单次检查。
   * 用 Bun.spawn 执行 checkCommand，exit code 为 0 表示条件满足。
   * 返回是否触发了事件。
   */
  async checkOne(watcher: WatcherDef): Promise<boolean> {
    const now = new Date();
    const nowISO = now.toISOString();

    // Update lastCheckAt
    this.stmtUpdateCheckAt.run(watcher.id, nowISO);

    let checkOutput: string;
    let exitCode: number;

    try {
      const proc = Bun.spawn(["sh", "-c", watcher.checkCommand], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      exitCode = proc.exitCode ?? 1;
      checkOutput = stdout;
    } catch (err) {
      console.error(`[EventWatcher] Command failed for "${watcher.name}" (${watcher.id}):`, err);
      return false;
    }

    // Simple mode: exit code 0 means condition met
    if (exitCode !== 0) {
      return false;
    }

    // Cooldown check: don't re-trigger if within cooldown period
    if (watcher.lastTriggeredAt) {
      const lastTriggered = new Date(watcher.lastTriggeredAt).getTime();
      if (now.getTime() - lastTriggered < watcher.cooldownMs) {
        return false;
      }
    }

    // Condition met and not in cooldown — trigger
    this.stmtUpdateTriggeredAt.run(watcher.id, nowISO);

    const updatedWatcher: WatcherDef = {
      ...watcher,
      lastCheckAt: nowISO,
      lastTriggeredAt: nowISO,
    };

    console.log(`[EventWatcher] Triggered watcher "${watcher.name}" (${watcher.id})`);
    this.emit({ type: "watcher_trigger", watcher: updatedWatcher, checkOutput });

    return true;
  }

  // --- Lifecycle ---

  /**
   * 启动所有 enabled 的 watcher，每个 watcher 按自己的 intervalMs 独立运行
   */
  start(): void {
    this.running = true;
    const rows = this.stmtListEnabled.all() as WatcherRow[];

    for (const row of rows) {
      this.startOne(this.rowToWatcher(row));
    }

    console.log(`[EventWatcher] Started ${rows.length} watcher(s)`);
  }

  /**
   * 停止所有定时器
   */
  stop(): void {
    this.running = false;
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    console.log("[EventWatcher] Stopped all watchers");
  }

  /**
   * 启动单个 watcher 的定时器
   */
  private startOne(watcher: WatcherDef): void {
    if (this.timers.has(watcher.id)) return;

    const timer = setInterval(async () => {
      // Re-fetch from DB to get latest state (lastTriggeredAt etc.)
      const row = this.stmtGetWatcher.get(watcher.id) as WatcherRow | undefined;
      if (!row || row.enabled !== 1) {
        this.stopOne(watcher.id);
        return;
      }
      await this.checkOne(this.rowToWatcher(row));
    }, watcher.intervalMs);

    this.timers.set(watcher.id, timer);
  }

  /**
   * 停止单个 watcher 的定时器
   */
  private stopOne(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }
}
