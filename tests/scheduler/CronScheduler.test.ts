import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/db/Database";
import { CronScheduler } from "../../src/scheduler/CronScheduler";
import type { SchedulerEvent } from "../../src/scheduler/types";
import { unlinkSync } from "node:fs";

const TEST_DB = "/tmp/little_claw_scheduler_test.db";

let db: Database;
let scheduler: CronScheduler;

beforeEach(() => {
  db = new Database(TEST_DB);
  scheduler = new CronScheduler(db);
});

afterEach(() => {
  scheduler.stop();
  db.close();
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

test("addJob and listJobs", () => {
  const job = scheduler.addJob({
    name: "Morning greeting",
    cronExpr: "0 8 * * *",
    prompt: "Good morning!",
    sessionId: "session-1",
    enabled: true,
  });

  expect(job.id).toBeTruthy();
  expect(job.name).toBe("Morning greeting");
  expect(job.cronExpr).toBe("0 8 * * *");
  expect(job.prompt).toBe("Good morning!");
  expect(job.sessionId).toBe("session-1");
  expect(job.enabled).toBe(true);
  expect(job.createdAt).toBeTruthy();
  expect(job.nextRunAt).toBeTruthy();

  const jobs = scheduler.listJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0].id).toBe(job.id);
});

test("removeJob", () => {
  const job = scheduler.addJob({
    name: "test",
    cronExpr: "*/5 * * * *",
    prompt: "ping",
    sessionId: "s1",
    enabled: true,
  });

  scheduler.removeJob(job.id);
  expect(scheduler.listJobs()).toHaveLength(0);
});

test("updateJob", () => {
  const job = scheduler.addJob({
    name: "old name",
    cronExpr: "0 8 * * *",
    prompt: "old prompt",
    sessionId: "s1",
    enabled: true,
  });

  const updated = scheduler.updateJob(job.id, {
    name: "new name",
    prompt: "new prompt",
    enabled: false,
  });

  expect(updated).not.toBeNull();
  expect(updated!.name).toBe("new name");
  expect(updated!.prompt).toBe("new prompt");
  expect(updated!.enabled).toBe(false);
  // cronExpr should remain unchanged
  expect(updated!.cronExpr).toBe("0 8 * * *");
});

test("updateJob with new cronExpr recalculates nextRunAt", () => {
  const job = scheduler.addJob({
    name: "test",
    cronExpr: "0 8 * * *",
    prompt: "hello",
    sessionId: "s1",
    enabled: true,
  });

  const originalNextRun = job.nextRunAt;

  const updated = scheduler.updateJob(job.id, {
    cronExpr: "30 14 * * *",
  });

  expect(updated).not.toBeNull();
  expect(updated!.cronExpr).toBe("30 14 * * *");
  // nextRunAt should change
  expect(updated!.nextRunAt).not.toBe(originalNextRun);
});

test("updateJob returns null for non-existent id", () => {
  const result = scheduler.updateJob("non-existent", { name: "test" });
  expect(result).toBeNull();
});

test("getNextRun returns future date", () => {
  const next = scheduler.getNextRun("0 8 * * *");
  expect(next).toBeInstanceOf(Date);
  expect(next.getTime()).toBeGreaterThan(Date.now());
});

test("getNextRun with from parameter", () => {
  const from = new Date("2026-03-31T07:00:00");
  const next = scheduler.getNextRun("0 8 * * *", from);
  expect(next.getHours()).toBe(8);
  expect(next.getMinutes()).toBe(0);
});

test("onTrigger registers callback", () => {
  const events: SchedulerEvent[] = [];
  scheduler.onTrigger((event) => events.push(event));

  // Add a job that matches every minute
  scheduler.addJob({
    name: "every minute",
    cronExpr: "* * * * *",
    prompt: "tick",
    sessionId: "s1",
    enabled: true,
  });

  // Start will do an immediate tick, which should trigger the job
  scheduler.start();

  // The "* * * * *" cron matches every minute, so the immediate tick should trigger it
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("cron_trigger");
  if (events[0].type === "cron_trigger") {
    expect(events[0].job.name).toBe("every minute");
    expect(events[0].job.lastRunAt).toBeTruthy();
    expect(events[0].job.nextRunAt).toBeTruthy();
  }
});

test("disabled jobs are not triggered", () => {
  const events: SchedulerEvent[] = [];
  scheduler.onTrigger((event) => events.push(event));

  scheduler.addJob({
    name: "disabled job",
    cronExpr: "* * * * *",
    prompt: "should not trigger",
    sessionId: "s1",
    enabled: false,
  });

  scheduler.start();

  expect(events).toHaveLength(0);
});

test("jobs persist across scheduler instances", () => {
  scheduler.addJob({
    name: "persistent",
    cronExpr: "0 9 * * *",
    prompt: "hello",
    sessionId: "s1",
    enabled: true,
  });

  // Create new scheduler with same database
  const scheduler2 = new CronScheduler(db);
  const jobs = scheduler2.listJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0].name).toBe("persistent");
});

test("start is idempotent", () => {
  // Calling start twice shouldn't create two timers
  scheduler.start();
  scheduler.start();
  // If this doesn't throw or hang, it's correct
  scheduler.stop();
});

test("stop without start is safe", () => {
  // Should not throw
  scheduler.stop();
});
