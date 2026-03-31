import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/db/Database";
import { EventWatcher } from "../../src/scheduler/EventWatcher";
import { createWatcherTool } from "../../src/tools/builtin/WatcherTool";
import type { Tool } from "../../src/tools/types";
import { unlinkSync } from "node:fs";

const TEST_DB = "/tmp/little_claw_watcher_tool_test.db";

let db: Database;
let eventWatcher: EventWatcher;
let tool: Tool;

beforeEach(() => {
  db = new Database(TEST_DB);
  eventWatcher = new EventWatcher(db);
  tool = createWatcherTool({
    watcher: eventWatcher,
    getSessionId: () => "test-session-1",
  });
});

afterEach(() => {
  eventWatcher.stop();
  db.close();
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

test("create action creates a watcher", async () => {
  const result = await tool.execute({
    action: "create",
    name: "api health",
    check_command: "curl -sf https://example.com/health",
    condition: "API returns 200",
    prompt: "The API is back up!",
    interval_minutes: 2,
  });

  expect(result.success).toBe(true);
  expect(result.output).toContain("Watcher created successfully");
  expect(result.output).toContain("api health");
  expect(result.output).toContain("curl -sf https://example.com/health");
  expect(result.output).toContain("Condition: API returns 200");
  expect(result.output).toContain("2 minute(s)");

  const watchers = eventWatcher.listWatchers();
  expect(watchers).toHaveLength(1);
  expect(watchers[0].sessionId).toBe("test-session-1");
  expect(watchers[0].intervalMs).toBe(120000);
  expect(watchers[0].cooldownMs).toBe(300000);
});

test("create action uses default interval of 1 minute", async () => {
  await tool.execute({
    action: "create",
    name: "test",
    check_command: "true",
    prompt: "ping",
  });

  const watchers = eventWatcher.listWatchers();
  expect(watchers[0].intervalMs).toBe(60000);
});

test("create action fails without required params", async () => {
  const result = await tool.execute({ action: "create", name: "test" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("Missing required parameters");
});

test("list action returns all watchers", async () => {
  // Empty list
  let result = await tool.execute({ action: "list" });
  expect(result.success).toBe(true);
  expect(result.output).toContain("No watchers configured");

  // Add a watcher
  await tool.execute({
    action: "create",
    name: "test watcher",
    check_command: "echo ok",
    prompt: "triggered",
  });

  result = await tool.execute({ action: "list" });
  expect(result.success).toBe(true);
  expect(result.output).toContain("1 watcher(s)");
  expect(result.output).toContain("test watcher");
  expect(result.output).toContain("[enabled]");
});

test("delete action removes a watcher", async () => {
  const createResult = await tool.execute({
    action: "create",
    name: "to delete",
    check_command: "echo ok",
    prompt: "hello",
  });

  const idMatch = createResult.output.match(/ID: (.+)/);
  const watcherId = idMatch![1];

  const result = await tool.execute({ action: "delete", watcher_id: watcherId });
  expect(result.success).toBe(true);
  expect(result.output).toContain("deleted");

  expect(eventWatcher.listWatchers()).toHaveLength(0);
});

test("delete action fails without watcher_id", async () => {
  const result = await tool.execute({ action: "delete" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("watcher_id");
});

test("disable action disables a watcher", async () => {
  const createResult = await tool.execute({
    action: "create",
    name: "to disable",
    check_command: "echo ok",
    prompt: "hello",
  });

  const idMatch = createResult.output.match(/ID: (.+)/);
  const watcherId = idMatch![1];

  const result = await tool.execute({ action: "disable", watcher_id: watcherId });
  expect(result.success).toBe(true);
  expect(result.output).toContain("disabled");

  const watchers = eventWatcher.listWatchers();
  expect(watchers[0].enabled).toBe(false);
});

test("enable action enables a watcher", async () => {
  const createResult = await tool.execute({
    action: "create",
    name: "to enable",
    check_command: "echo ok",
    prompt: "hello",
  });

  const idMatch = createResult.output.match(/ID: (.+)/);
  const watcherId = idMatch![1];

  await tool.execute({ action: "disable", watcher_id: watcherId });

  const result = await tool.execute({ action: "enable", watcher_id: watcherId });
  expect(result.success).toBe(true);
  expect(result.output).toContain("enabled");

  const watchers = eventWatcher.listWatchers();
  expect(watchers[0].enabled).toBe(true);
});

test("enable/disable returns error for non-existent watcher", async () => {
  const result = await tool.execute({ action: "enable", watcher_id: "non-existent" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("not found");
});

test("unknown action returns error", async () => {
  const result = await tool.execute({ action: "invalid" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("Unknown action");
});
