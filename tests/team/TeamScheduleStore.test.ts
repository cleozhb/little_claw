import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import { AgentRegistry } from "../../src/team/AgentRegistry.ts";
import { TaskQueue } from "../../src/team/TaskQueue.ts";
import { TeamScheduleAdapter } from "../../src/team/TeamScheduleAdapter.ts";
import { TeamScheduleStore } from "../../src/team/TeamScheduleStore.ts";
import { TeamCronScheduler } from "../../src/team/TeamSchedulers.ts";

const TEST_DB = "/tmp/little_claw_team_schedules_test.db";

let db: Database;
let agentDir: string;

beforeEach(() => {
  cleanupDb();
  db = new Database(TEST_DB);
  agentDir = join(tmpdir(), `little-claw-team-schedules-${crypto.randomUUID()}`);
});

afterEach(() => {
  db.close();
  rmSync(agentDir, { recursive: true, force: true });
  cleanupDb();
});

describe("TeamScheduleStore", () => {
  test("syncs cron and watcher schedules from agent.yaml", () => {
    writeAgent(
      "podcast",
      `name: podcast
display_name: Podcast
role: Translate podcasts
status: active
default_project: podcast-translation
task_tags:
  - podcast
cron_jobs:
  - key: daily-feed
    name: Daily feed
    cron: "* * * * *"
    prompt: "Check feeds"
    tags:
      - podcast
    priority: 2
watchers:
  - key: marker
    name: Marker watcher
    check_command: "test -f /tmp/little-claw-marker"
    condition: "marker exists"
    prompt: "Process marker"
    interval_minutes: 2
    cooldown_minutes: 10
`,
    );
    const registry = new AgentRegistry(agentDir);
    const agents = registry.loadAll();
    const schedules = new TeamScheduleStore(db);

    const result = schedules.syncFromAgents(agents);
    const list = schedules.listSchedules();

    expect(result.created).toBe(2);
    expect(result.deleted).toBe(0);
    expect(list).toHaveLength(2);
    expect(list.map((schedule) => schedule.type).sort()).toEqual(["cron", "watcher"]);
    expect(list.find((schedule) => schedule.type === "cron")?.agentName).toBe("podcast");
    expect(list.find((schedule) => schedule.type === "cron")?.project).toBe("podcast-translation");
    expect(list.find((schedule) => schedule.type === "watcher")?.intervalMs).toBe(120_000);
    expect(list.find((schedule) => schedule.type === "watcher")?.cooldownMs).toBe(600_000);
  });

  test("removes agent_yaml schedules that were deleted from agent.yaml", () => {
    writeAgent(
      "podcast",
      `name: podcast
display_name: Podcast
role: Translate podcasts
status: active
cron_jobs:
  - key: daily-feed
    name: Daily feed
    cron: "* * * * *"
    prompt: "Check feeds"
  - key: weekly-feed
    name: Weekly feed
    cron: "0 8 * * 1"
    prompt: "Check weekly feeds"
`,
    );
    const registry = new AgentRegistry(agentDir);
    const schedules = new TeamScheduleStore(db);

    schedules.syncFromAgents(registry.loadAll());
    writeAgent(
      "podcast",
      `name: podcast
display_name: Podcast
role: Translate podcasts
status: active
cron_jobs:
  - key: daily-feed
    name: Daily feed
    cron: "* * * * *"
    prompt: "Check feeds"
`,
    );

    const result = schedules.syncFromAgents(registry.loadAll());

    expect(result.deleted).toBe(1);
    expect(schedules.listSchedules().map((schedule) => schedule.name)).toEqual(["Daily feed"]);
  });

  test("updates enabled state and records runs", () => {
    const schedules = new TeamScheduleStore(db);
    const schedule = schedules.createSchedule({
      type: "cron",
      name: "Daily review",
      agentName: "coordinator",
      prompt: "Review work",
      cronExpr: "0 8 * * *",
    });

    const disabled = schedules.updateSchedule(schedule.id, { enabled: false });
    const run = schedules.recordRun({
      scheduleId: schedule.id,
      triggerType: "manual",
      agentName: "coordinator",
      status: "skipped",
      error: "Agent is paused",
    });

    expect(disabled?.enabled).toBe(false);
    expect(run.status).toBe("skipped");
    expect(schedules.listRuns({ scheduleId: schedule.id })).toHaveLength(1);
    expect(schedules.getSchedule(schedule.id)?.lastStatus).toBe("skipped");
  });
});

describe("TeamScheduleAdapter", () => {
  test("runNow creates an assigned TaskQueue task for the schedule owner", () => {
    writeAgent("coder", validAgentYaml("coder", "active"));
    const registry = new AgentRegistry(agentDir);
    registry.loadAll();
    const tasks = new TaskQueue(db);
    const schedules = new TeamScheduleStore(db);
    const schedule = schedules.createSchedule({
      type: "cron",
      name: "Nightly code check",
      agentName: "coder",
      prompt: "Check code health",
      cronExpr: "0 1 * * *",
      tags: ["code"],
      project: "engineering",
    });
    const adapter = new TeamScheduleAdapter({ schedules, agents: registry, tasks });

    const result = adapter.runNow(schedule.id);
    const task = tasks.getTask(result.task!.id);

    expect(result.run.status).toBe("created");
    expect(task?.status).toBe("assigned");
    expect(task?.assignedTo).toBe("coder");
    expect(task?.createdBy).toBe(`scheduler:${schedule.id}`);
    expect(task?.tags).toContain("scheduled");
    expect(task?.project).toBe("engineering");
  });

  test("runNow skips paused agents instead of creating work", () => {
    writeAgent("coder", validAgentYaml("coder", "paused"));
    const registry = new AgentRegistry(agentDir);
    registry.loadAll();
    const tasks = new TaskQueue(db);
    const schedules = new TeamScheduleStore(db);
    const schedule = schedules.createSchedule({
      type: "cron",
      name: "Paused check",
      agentName: "coder",
      prompt: "Should not run",
      cronExpr: "0 1 * * *",
    });
    const adapter = new TeamScheduleAdapter({ schedules, agents: registry, tasks });

    const result = adapter.runNow(schedule.id);

    expect(result.run.status).toBe("skipped");
    expect(result.run.error).toContain("paused");
    expect(tasks.listTasks()).toHaveLength(0);
  });
});

describe("TeamCronScheduler", () => {
  test("tick emits due cron schedules", () => {
    const schedules = new TeamScheduleStore(db);
    const schedule = schedules.createSchedule({
      type: "cron",
      name: "Every minute",
      agentName: "coder",
      prompt: "Run every minute",
      cronExpr: "* * * * *",
    });
    const cron = new TeamCronScheduler(schedules);
    const triggered: string[] = [];
    cron.onTrigger((event) => {
      triggered.push(event.schedule.id);
    });

    cron.tick(new Date("2026-05-02T10:30:00.000Z"));

    expect(triggered).toEqual([schedule.id]);
    expect(schedules.getSchedule(schedule.id)?.lastTriggeredAt).toBe("2026-05-02T10:30:00.000Z");
  });
});

function writeAgent(name: string, yaml: string): void {
  const dir = join(agentDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), yaml, "utf8");
  writeFileSync(join(dir, "SOUL.md"), "# Soul\nTest soul.\n", "utf8");
  writeFileSync(join(dir, "AGENTS.md"), "# Agent Operating Instructions\nTest process.\n", "utf8");
}

function validAgentYaml(name: string, status: "active" | "paused"): string {
  return `name: ${name}
display_name: ${name}
role: Test agent
status: ${status}
task_tags:
  - code
cron_jobs: []
`;
}

function cleanupDb(): void {
  for (const path of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
