import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/db/Database";
import { CronScheduler } from "../../src/scheduler/CronScheduler";
import { createCronTool } from "../../src/tools/builtin/CronTool";
import type { Tool } from "../../src/tools/types";
import { unlinkSync } from "node:fs";

const TEST_DB = "/tmp/little_claw_cron_tool_test.db";

let db: Database;
let scheduler: CronScheduler;
let tool: Tool;

beforeEach(() => {
  db = new Database(TEST_DB);
  scheduler = new CronScheduler(db);
  tool = createCronTool({
    scheduler,
    getSessionId: () => "test-session-1",
  });
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

test("create action creates a cron job", async () => {
  const result = await tool.execute({
    action: "create",
    name: "morning reminder",
    cron_expr: "0 8 * * *",
    prompt: "Good morning!",
  });

  expect(result.success).toBe(true);
  expect(result.output).toContain("Cron job created successfully");
  expect(result.output).toContain("morning reminder");
  expect(result.output).toContain("0 8 * * *");
  expect(result.output).toContain("Next run:");

  const jobs = scheduler.listJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0].sessionId).toBe("test-session-1");
});

test("create action fails without required params", async () => {
  const result = await tool.execute({ action: "create", name: "test" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("Missing required parameters");
});

test("list action returns all jobs", async () => {
  // Empty list
  let result = await tool.execute({ action: "list" });
  expect(result.success).toBe(true);
  expect(result.output).toContain("No cron jobs configured");

  // Add a job
  await tool.execute({
    action: "create",
    name: "test job",
    cron_expr: "*/5 * * * *",
    prompt: "ping",
  });

  result = await tool.execute({ action: "list" });
  expect(result.success).toBe(true);
  expect(result.output).toContain("1 cron job(s)");
  expect(result.output).toContain("test job");
  expect(result.output).toContain("[enabled]");
});

test("delete action removes a job", async () => {
  const createResult = await tool.execute({
    action: "create",
    name: "to delete",
    cron_expr: "0 9 * * *",
    prompt: "hello",
  });

  const idMatch = createResult.output.match(/ID: (.+)/);
  const jobId = idMatch![1];

  const result = await tool.execute({ action: "delete", job_id: jobId });
  expect(result.success).toBe(true);
  expect(result.output).toContain("deleted");

  expect(scheduler.listJobs()).toHaveLength(0);
});

test("delete action fails without job_id", async () => {
  const result = await tool.execute({ action: "delete" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("job_id");
});

test("disable action disables a job", async () => {
  const createResult = await tool.execute({
    action: "create",
    name: "to disable",
    cron_expr: "0 9 * * *",
    prompt: "hello",
  });

  const idMatch = createResult.output.match(/ID: (.+)/);
  const jobId = idMatch![1];

  const result = await tool.execute({ action: "disable", job_id: jobId });
  expect(result.success).toBe(true);
  expect(result.output).toContain("disabled");

  const jobs = scheduler.listJobs();
  expect(jobs[0].enabled).toBe(false);
});

test("enable action enables a job", async () => {
  const createResult = await tool.execute({
    action: "create",
    name: "to enable",
    cron_expr: "0 9 * * *",
    prompt: "hello",
  });

  const idMatch = createResult.output.match(/ID: (.+)/);
  const jobId = idMatch![1];

  // Disable first
  await tool.execute({ action: "disable", job_id: jobId });

  const result = await tool.execute({ action: "enable", job_id: jobId });
  expect(result.success).toBe(true);
  expect(result.output).toContain("enabled");

  const jobs = scheduler.listJobs();
  expect(jobs[0].enabled).toBe(true);
});

test("enable/disable returns error for non-existent job", async () => {
  const result = await tool.execute({ action: "enable", job_id: "non-existent" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("not found");
});

test("unknown action returns error", async () => {
  const result = await tool.execute({ action: "invalid" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("Unknown action");
});
