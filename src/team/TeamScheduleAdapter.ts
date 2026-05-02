import type { AgentRegistry } from "./AgentRegistry.ts";
import type { Task, TaskQueue } from "./TaskQueue.ts";
import type {
  TeamSchedule,
  TeamScheduleRun,
  TeamScheduleStore,
  TeamScheduleRunTriggerType,
} from "./TeamScheduleStore.ts";
import type { TeamScheduleTrigger } from "./TeamSchedulers.ts";

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
}

export class TeamScheduleAdapter {
  private schedules: TeamScheduleStore;
  private agents: AgentRegistry;
  private tasks: TaskQueue;
  private handlers = new Set<TeamScheduleRunHandler>();

  constructor(options: TeamScheduleAdapterOptions) {
    this.schedules = options.schedules;
    this.agents = options.agents;
    this.tasks = options.tasks;
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
