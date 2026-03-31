import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/db/Database";
import { EventWatcher } from "../../src/scheduler/EventWatcher";
import type { SchedulerEvent } from "../../src/scheduler/types";
import { unlinkSync } from "node:fs";

const TEST_DB = "/tmp/little_claw_watcher_test.db";

let db: Database;
let watcher: EventWatcher;

beforeEach(() => {
  db = new Database(TEST_DB);
  watcher = new EventWatcher(db);
});

afterEach(() => {
  watcher.stop();
  db.close();
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

test("addWatcher and listWatchers", () => {
  const w = watcher.addWatcher({
    name: "price check",
    checkCommand: "echo ok",
    condition: "price > 200",
    prompt: "Price alert!",
    intervalMs: 60000,
    cooldownMs: 300000,
    sessionId: "s1",
    enabled: true,
  });

  expect(w.id).toBeTruthy();
  expect(w.name).toBe("price check");
  expect(w.checkCommand).toBe("echo ok");
  expect(w.condition).toBe("price > 200");
  expect(w.prompt).toBe("Price alert!");
  expect(w.intervalMs).toBe(60000);
  expect(w.cooldownMs).toBe(300000);
  expect(w.sessionId).toBe("s1");
  expect(w.enabled).toBe(true);
  expect(w.createdAt).toBeTruthy();
  expect(w.lastCheckAt).toBeUndefined();
  expect(w.lastTriggeredAt).toBeUndefined();

  const list = watcher.listWatchers();
  expect(list).toHaveLength(1);
  expect(list[0].id).toBe(w.id);
});

test("removeWatcher", () => {
  const w = watcher.addWatcher({
    name: "test",
    checkCommand: "true",
    condition: "always",
    prompt: "ping",
    intervalMs: 1000,
    cooldownMs: 0,
    sessionId: "s1",
    enabled: true,
  });

  watcher.removeWatcher(w.id);
  expect(watcher.listWatchers()).toHaveLength(0);
});

test("updateWatcher", () => {
  const w = watcher.addWatcher({
    name: "old name",
    checkCommand: "echo old",
    condition: "old condition",
    prompt: "old prompt",
    intervalMs: 60000,
    cooldownMs: 300000,
    sessionId: "s1",
    enabled: true,
  });

  const updated = watcher.updateWatcher(w.id, {
    name: "new name",
    prompt: "new prompt",
    enabled: false,
  });

  expect(updated).not.toBeNull();
  expect(updated!.name).toBe("new name");
  expect(updated!.prompt).toBe("new prompt");
  expect(updated!.enabled).toBe(false);
  // Unchanged fields
  expect(updated!.checkCommand).toBe("echo old");
  expect(updated!.condition).toBe("old condition");
  expect(updated!.intervalMs).toBe(60000);
});

test("updateWatcher returns null for non-existent id", () => {
  const result = watcher.updateWatcher("non-existent", { name: "test" });
  expect(result).toBeNull();
});

test("checkOne triggers on exit code 0", async () => {
  const events: SchedulerEvent[] = [];
  watcher.onTrigger((event) => events.push(event));

  const w = watcher.addWatcher({
    name: "success check",
    checkCommand: "echo hello",
    condition: "always true",
    prompt: "triggered!",
    intervalMs: 60000,
    cooldownMs: 0,
    sessionId: "s1",
    enabled: true,
  });

  const triggered = await watcher.checkOne(w);
  expect(triggered).toBe(true);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("watcher_trigger");
  if (events[0].type === "watcher_trigger") {
    expect(events[0].watcher.name).toBe("success check");
    expect(events[0].checkOutput).toBe("hello\n");
    expect(events[0].watcher.lastTriggeredAt).toBeTruthy();
    expect(events[0].watcher.lastCheckAt).toBeTruthy();
  }
});

test("checkOne does not trigger on non-zero exit code", async () => {
  const events: SchedulerEvent[] = [];
  watcher.onTrigger((event) => events.push(event));

  const w = watcher.addWatcher({
    name: "fail check",
    checkCommand: "exit 1",
    condition: "never",
    prompt: "should not trigger",
    intervalMs: 60000,
    cooldownMs: 0,
    sessionId: "s1",
    enabled: true,
  });

  const triggered = await watcher.checkOne(w);
  expect(triggered).toBe(false);
  expect(events).toHaveLength(0);
});

test("checkOne respects cooldown", async () => {
  const events: SchedulerEvent[] = [];
  watcher.onTrigger((event) => events.push(event));

  const w = watcher.addWatcher({
    name: "cooldown test",
    checkCommand: "echo ok",
    condition: "always",
    prompt: "ping",
    intervalMs: 1000,
    cooldownMs: 300000, // 5 minutes
    sessionId: "s1",
    enabled: true,
  });

  // First check should trigger
  const first = await watcher.checkOne(w);
  expect(first).toBe(true);
  expect(events).toHaveLength(1);

  // Re-fetch watcher from DB to get updated lastTriggeredAt
  const watchers = watcher.listWatchers();
  const updated = watchers[0];

  // Second check within cooldown should NOT trigger
  const second = await watcher.checkOne(updated);
  expect(second).toBe(false);
  expect(events).toHaveLength(1); // Still 1
});

test("checkOne triggers again after cooldown expires", async () => {
  const events: SchedulerEvent[] = [];
  watcher.onTrigger((event) => events.push(event));

  const w = watcher.addWatcher({
    name: "expired cooldown",
    checkCommand: "echo ok",
    condition: "always",
    prompt: "ping",
    intervalMs: 1000,
    cooldownMs: 100, // 100ms cooldown for testing
    sessionId: "s1",
    enabled: true,
  });

  // First trigger
  await watcher.checkOne(w);
  expect(events).toHaveLength(1);

  // Wait for cooldown to expire
  await Bun.sleep(150);

  // Re-fetch and check again — should trigger
  const updated = watcher.listWatchers()[0];
  const second = await watcher.checkOne(updated);
  expect(second).toBe(true);
  expect(events).toHaveLength(2);
});

test("checkOne handles command failure gracefully", async () => {
  const events: SchedulerEvent[] = [];
  watcher.onTrigger((event) => events.push(event));

  const w = watcher.addWatcher({
    name: "bad command",
    checkCommand: "/nonexistent/binary",
    condition: "never",
    prompt: "should not trigger",
    intervalMs: 60000,
    cooldownMs: 0,
    sessionId: "s1",
    enabled: true,
  });

  const triggered = await watcher.checkOne(w);
  expect(triggered).toBe(false);
  expect(events).toHaveLength(0);
});

test("checkOne captures stdout output", async () => {
  const events: SchedulerEvent[] = [];
  watcher.onTrigger((event) => events.push(event));

  const w = watcher.addWatcher({
    name: "output capture",
    checkCommand: "echo 'stock price: 250'",
    condition: "price > 200",
    prompt: "Price alert",
    intervalMs: 60000,
    cooldownMs: 0,
    sessionId: "s1",
    enabled: true,
  });

  await watcher.checkOne(w);
  expect(events).toHaveLength(1);
  if (events[0].type === "watcher_trigger") {
    expect(events[0].checkOutput).toBe("stock price: 250\n");
  }
});

test("watchers persist across instances", () => {
  watcher.addWatcher({
    name: "persistent",
    checkCommand: "echo hi",
    condition: "always",
    prompt: "hello",
    intervalMs: 60000,
    cooldownMs: 300000,
    sessionId: "s1",
    enabled: true,
  });

  const watcher2 = new EventWatcher(db);
  const list = watcher2.listWatchers();
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe("persistent");
});

test("start and stop lifecycle", () => {
  watcher.addWatcher({
    name: "lifecycle test",
    checkCommand: "echo ok",
    condition: "always",
    prompt: "ping",
    intervalMs: 60000,
    cooldownMs: 0,
    sessionId: "s1",
    enabled: true,
  });

  // Should not throw
  watcher.start();
  watcher.stop();
});

test("stop without start is safe", () => {
  watcher.stop();
});

test("disabled watchers are not started", () => {
  watcher.addWatcher({
    name: "disabled",
    checkCommand: "echo ok",
    condition: "always",
    prompt: "ping",
    intervalMs: 1000,
    cooldownMs: 0,
    sessionId: "s1",
    enabled: false,
  });

  // start() only starts enabled watchers — no timer should be created
  watcher.start();
  watcher.stop();
});

test("checkOne updates lastCheckAt even when not triggered", async () => {
  const w = watcher.addWatcher({
    name: "check tracking",
    checkCommand: "exit 1",
    condition: "never",
    prompt: "nope",
    intervalMs: 60000,
    cooldownMs: 0,
    sessionId: "s1",
    enabled: true,
  });

  expect(w.lastCheckAt).toBeUndefined();

  await watcher.checkOne(w);

  const updated = watcher.listWatchers()[0];
  expect(updated.lastCheckAt).toBeTruthy();
  expect(updated.lastTriggeredAt).toBeUndefined();
});
