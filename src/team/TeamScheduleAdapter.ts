import type { AgentRegistry } from "./AgentRegistry.ts";
import type { Task, TaskQueue } from "./TaskQueue.ts";
import type { ContextHub } from "../memory/ContextHub.ts";
import type {
  TeamSchedule,
  TeamScheduleRun,
  TeamScheduleStore,
  TeamScheduleRunTriggerType,
} from "./TeamScheduleStore.ts";
import type { TeamScheduleTrigger } from "./TeamSchedulers.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TeamScheduleAdapterResult {
  schedule: TeamSchedule;
  run: TeamScheduleRun;
  task?: Task;
}

type TeamScheduleRunHandler = (result: TeamScheduleAdapterResult) => void;

export interface TeamScheduleAdapterOptions {
  schedules: TeamScheduleStore;
  agents: AgentRegistry;
  tasks: TaskQueue;
  contextHub?: ContextHub;
}

export class TeamScheduleAdapter {
  private schedules: TeamScheduleStore;
  private agents: AgentRegistry;
  private tasks: TaskQueue;
  private contextHub?: ContextHub;
  private handlers = new Set<TeamScheduleRunHandler>();

  constructor(options: TeamScheduleAdapterOptions) {
    this.schedules = options.schedules;
    this.agents = options.agents;
    this.tasks = options.tasks;
    this.contextHub = options.contextHub;
  }

  onRun(handler: TeamScheduleRunHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  handleTrigger(event: TeamScheduleTrigger): TeamScheduleAdapterResult {
    const triggerType = event.type === "team_cron_trigger" ? "cron" : "watcher";
    return this.createTaskForSchedule(event.schedule, {
      triggerType,
      checkOutput: event.type === "team_watcher_trigger" ? event.checkOutput : undefined,
    });
  }

  runNow(scheduleId: string): TeamScheduleAdapterResult {
    const schedule = this.schedules.getSchedule(scheduleId);
    if (!schedule) {
      throw new Error(`Team schedule not found: ${scheduleId}`);
    }
    return this.createTaskForSchedule(schedule, { triggerType: "manual" });
  }

  private createTaskForSchedule(
    schedule: TeamSchedule,
    options: { triggerType: TeamScheduleRunTriggerType; checkOutput?: string },
  ): TeamScheduleAdapterResult {
    const agent = this.agents.get(schedule.agentName);
    if (!agent) {
      return this.recordSkipped(schedule, options, `Agent not found: ${schedule.agentName}`);
    }
    if (agent.config.status !== "active") {
      return this.recordSkipped(schedule, options, `Agent is ${agent.config.status}`);
    }
    const skipReason = this.getPreflightSkipReason(schedule, options);
    if (skipReason) {
      return this.recordSkipped(schedule, options, skipReason);
    }

    try {
      const task = this.tasks.createTask({
        title: `[scheduled] ${schedule.name}`,
        description: buildScheduledTaskDescription(schedule, options.checkOutput),
        createdBy: `scheduler:${schedule.id}`,
        assignedTo: schedule.agentName,
        project: schedule.project,
        channelId: schedule.channelId,
        tags: uniqueStrings(["scheduled", schedule.type, ...schedule.tags]),
        priority: schedule.priority,
        maxRetries: schedule.maxRetries,
      });
      const run = this.schedules.recordRun({
        scheduleId: schedule.id,
        triggerType: options.triggerType,
        agentName: schedule.agentName,
        status: "created",
        taskId: task.id,
        triggerPayload: buildTriggerPayload(schedule, options.checkOutput),
      });
      return this.emit({ schedule: this.schedules.getSchedule(schedule.id) ?? schedule, run, task });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const run = this.schedules.recordRun({
        scheduleId: schedule.id,
        triggerType: options.triggerType,
        agentName: schedule.agentName,
        status: "failed_to_create",
        triggerPayload: buildTriggerPayload(schedule, options.checkOutput),
        error: message,
      });
      return this.emit({ schedule: this.schedules.getSchedule(schedule.id) ?? schedule, run });
    }
  }

  private recordSkipped(
    schedule: TeamSchedule,
    options: { triggerType: TeamScheduleRunTriggerType; checkOutput?: string },
    error: string,
  ): TeamScheduleAdapterResult {
    const run = this.schedules.recordRun({
      scheduleId: schedule.id,
      triggerType: options.triggerType,
      agentName: schedule.agentName,
      status: "skipped",
      triggerPayload: buildTriggerPayload(schedule, options.checkOutput),
      error,
    });
    return this.emit({ schedule: this.schedules.getSchedule(schedule.id) ?? schedule, run });
  }

  private emit(result: TeamScheduleAdapterResult): TeamScheduleAdapterResult {
    for (const handler of this.handlers) {
      handler(result);
    }
    return result;
  }

  private getPreflightSkipReason(
    schedule: TeamSchedule,
    options: { triggerType: TeamScheduleRunTriggerType },
  ): string | null {
    if (options.triggerType === "manual") return null;
    if (schedule.sourceKey !== "podcast-curator:cron:podcast-translation-status-check") {
      return null;
    }
    if (hasActivePodcastTranslationJob(this.contextHub, schedule.project)) {
      return null;
    }
    return "No active podcast translation jobs recorded; skipping status check.";
  }
}

function buildScheduledTaskDescription(schedule: TeamSchedule, checkOutput?: string): string {
  const lines = [
    schedule.prompt,
    "",
    "<scheduled_task>",
    `schedule_id: ${schedule.id}`,
    `schedule_name: ${schedule.name}`,
    `schedule_type: ${schedule.type}`,
    `agent: ${schedule.agentName}`,
    schedule.project ? `project: ${schedule.project}` : "project: none",
    schedule.cronExpr ? `cron: ${schedule.cronExpr}` : null,
    schedule.condition ? `condition: ${schedule.condition}` : null,
    checkOutput ? `check_output:\n${checkOutput}` : null,
    "</scheduled_task>",
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function buildTriggerPayload(schedule: TeamSchedule, checkOutput?: string): Record<string, unknown> {
  return {
    scheduleId: schedule.id,
    type: schedule.type,
    name: schedule.name,
    agentName: schedule.agentName,
    project: schedule.project,
    cronExpr: schedule.cronExpr,
    checkCommand: schedule.checkCommand,
    checkOutput,
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim() !== "")));
}

function hasActivePodcastTranslationJob(contextHub: ContextHub | undefined, project: string | undefined): boolean {
  if (!contextHub || project !== "podcast-translation") return false;

  const projectDir = join(contextHub.getHubDir(), "3-projects", project);
  const jsonPath = join(projectDir, "active-jobs.json");
  const mdPath = join(projectDir, "active-jobs.md");

  if (existsSync(jsonPath) && jsonHasActiveJob(readTextFile(jsonPath))) {
    return true;
  }
  if (existsSync(mdPath) && markdownHasActiveJob(readTextFile(mdPath))) {
    return true;
  }
  return false;
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function jsonHasActiveJob(content: string): boolean {
  if (!content.trim()) return false;
  try {
    return hasActiveJobRecord(JSON.parse(content));
  } catch {
    return false;
  }
}

function hasActiveJobRecord(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasActiveJobRecord);
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.jobs)) {
    return record.jobs.some(hasActiveJobRecord);
  }
  if (Object.values(record).some((item) => item && typeof item === "object" && hasActiveJobRecord(item))) {
    return true;
  }

  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  if (!status) return typeof record.job_id === "string" || typeof record.jobId === "string";
  return ACTIVE_JOB_STATUSES.has(status);
}

function markdownHasActiveJob(content: string): boolean {
  const text = content.toLowerCase();
  if (!text.includes("job_id") && !text.includes("job id")) return false;
  return ACTIVE_MARKDOWN_STATUS_RE.test(text);
}

const ACTIVE_JOB_STATUSES = new Set([
  "active",
  "pending",
  "queued",
  "running",
  "processing",
  "in_progress",
  "started",
]);

const ACTIVE_MARKDOWN_STATUS_RE = /\b(active|pending|queued|running|processing|in[_ -]?progress|started)\b/;
