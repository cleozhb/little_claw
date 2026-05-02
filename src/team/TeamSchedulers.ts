import { CronExpressionParser } from "cron-parser";
import type { TeamSchedule, TeamScheduleStore } from "./TeamScheduleStore.ts";

export type TeamScheduleTrigger =
  | { type: "team_cron_trigger"; schedule: TeamSchedule }
  | { type: "team_watcher_trigger"; schedule: TeamSchedule; checkOutput: string };

type TriggerHandler = (event: TeamScheduleTrigger) => void | Promise<void>;

export class TeamCronScheduler {
  private store: TeamScheduleStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private handlers = new Set<TriggerHandler>();

  constructor(store: TeamScheduleStore) {
    this.store = store;
  }

  onTrigger(handler: TriggerHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick();
    }, 60_000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = new Date()): void {
    const schedules = this.store.listSchedules({ type: "cron", enabled: true });
    for (const schedule of schedules) {
      if (!schedule.cronExpr) continue;
      try {
        if (!isTimeMatching(schedule.cronExpr, now)) continue;
        const updated = this.store.markTriggered(schedule.id, now.toISOString()) ?? schedule;
        this.emit({ type: "team_cron_trigger", schedule: updated });
      } catch (err) {
        console.error(
          `[TeamCronScheduler] Error processing schedule ${schedule.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private emit(event: TeamScheduleTrigger): void {
    for (const handler of this.handlers) {
      Promise.resolve(handler(event)).catch((err) => {
        console.error(
          "[TeamCronScheduler] Error in trigger handler:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }
}

export class TeamWatcherScheduler {
  private store: TeamScheduleStore;
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private runtimeConfigs = new Map<string, string>();
  private handlers = new Set<TriggerHandler>();
  private running = false;

  constructor(store: TeamScheduleStore) {
    this.store = store;

    this.store.onScheduleUpdated((schedule) => {
      if (!this.running || schedule.type !== "watcher") return;
      const nextConfig = watcherRuntimeConfig(schedule);
      if (this.runtimeConfigs.get(schedule.id) === nextConfig) return;
      this.stopOne(schedule.id);
      if (schedule.enabled) this.startOne(schedule);
    });
  }

  onTrigger(handler: TriggerHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const schedule of this.store.listSchedules({ type: "watcher", enabled: true })) {
      this.startOne(schedule);
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  async checkOne(schedule: TeamSchedule, now = new Date()): Promise<boolean> {
    if (schedule.type !== "watcher" || !schedule.checkCommand) return false;
    this.store.markChecked(schedule.id, now.toISOString());

    let stdout = "";
    let exitCode = 1;
    try {
      const proc = Bun.spawn(["sh", "-c", schedule.checkCommand], {
        stdout: "pipe",
        stderr: "pipe",
      });
      stdout = await new Response(proc.stdout).text();
      await proc.exited;
      exitCode = proc.exitCode ?? 1;
    } catch (err) {
      console.error(
        `[TeamWatcherScheduler] Command failed for "${schedule.name}" (${schedule.id}):`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }

    if (exitCode !== 0) return false;
    if (schedule.lastTriggeredAt && schedule.cooldownMs !== undefined) {
      const lastTriggered = Date.parse(schedule.lastTriggeredAt);
      if (Number.isFinite(lastTriggered) && now.getTime() - lastTriggered < schedule.cooldownMs) {
        return false;
      }
    }

    const updated = this.store.markTriggered(schedule.id, now.toISOString()) ?? schedule;
    this.emit({ type: "team_watcher_trigger", schedule: updated, checkOutput: stdout });
    return true;
  }

  private startOne(schedule: TeamSchedule): void {
    if (this.timers.has(schedule.id)) return;
    const intervalMs = schedule.intervalMs ?? 60_000;
    const timer = setInterval(() => {
      const latest = this.store.getSchedule(schedule.id);
      if (!latest || latest.type !== "watcher" || !latest.enabled) {
        this.stopOne(schedule.id);
        return;
      }
      this.checkOne(latest).catch((err) => {
        console.error(
          `[TeamWatcherScheduler] Error checking schedule ${schedule.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }, intervalMs);
    this.timers.set(schedule.id, timer);
    this.runtimeConfigs.set(schedule.id, watcherRuntimeConfig(schedule));
  }

  private stopOne(id: string): void {
    const timer = this.timers.get(id);
    if (!timer) return;
    clearInterval(timer);
    this.timers.delete(id);
    this.runtimeConfigs.delete(id);
  }

  private emit(event: TeamScheduleTrigger): void {
    for (const handler of this.handlers) {
      Promise.resolve(handler(event)).catch((err) => {
        console.error(
          "[TeamWatcherScheduler] Error in trigger handler:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }
}

function watcherRuntimeConfig(schedule: TeamSchedule): string {
  return JSON.stringify({
    enabled: schedule.enabled,
    checkCommand: schedule.checkCommand,
    intervalMs: schedule.intervalMs,
    cooldownMs: schedule.cooldownMs,
  });
}

function isTimeMatching(cronExpr: string, now: Date): boolean {
  const startOfMinute = new Date(now);
  startOfMinute.setSeconds(0, 0);

  const justBefore = new Date(startOfMinute.getTime() - 1000);
  const expr = CronExpressionParser.parse(cronExpr, { currentDate: justBefore });
  const nextDate = expr.next().toDate();

  return nextDate.getTime() === startOfMinute.getTime();
}
