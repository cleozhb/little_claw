import type { ChatOptions, LLMProvider } from "../llm/types.ts";
import type { Message } from "../types/message.ts";
import type { Tool } from "../tools/types.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { AgentRegistry, RegisteredAgent } from "./AgentRegistry.ts";
import type { ProjectChannel, ProjectChannelStore } from "./ProjectChannelStore.ts";
import type { CreateTaskDagNodeParams, Task, TaskQueue, TaskStatus } from "./TaskQueue.ts";
import type { TeamMessageStore, TeamMessage, TeamMessagePriority } from "./TeamMessageStore.ts";
import type { TeamSchedule, TeamScheduleStore, TeamScheduleType } from "./TeamScheduleStore.ts";

const LIST_TASKS_DEFAULT_LIMIT = 20;
const LIST_TASKS_MAX_LIMIT = 100;

export const COORDINATOR_TOOL_NAMES = [
  "create_task",
  "create_task_dag",
  "list_tasks",
  "assign_task",
  "delegate_task",
  "request_approval",
  "check_team_status",
  "send_message_to_agent",
  "post_to_project_channel",
  "summarize_project_channel",
  "create_team_schedule",
  "list_team_schedules",
  "update_team_schedule",
] as const;

export type CoordinatorToolName = (typeof COORDINATOR_TOOL_NAMES)[number];

export interface CoordinatorToolContext {
  tasks: TaskQueue;
  messages: TeamMessageStore;
  channels: ProjectChannelStore;
  agents: AgentRegistry;
  schedules?: TeamScheduleStore;
  llmProvider?: LLMProvider;
  getTaskDefaults?: () => CoordinatorTaskDefaults | undefined;
}

export interface CoordinatorTaskDefaults {
  project?: string;
  channelId?: string;
  sourceMessageId?: string;
}

export class CoordinatorLLMHelper {
  constructor(private llmProvider: LLMProvider) {}

  async summarizeProjectChannel(params: {
    channel: ProjectChannel;
    messages: TeamMessage[];
  }): Promise<string> {
    const content = formatProjectMessagesForSummary(params.messages);
    const userMessage: Message = {
      role: "user",
      content: `<project_channel>
slug: ${params.channel.slug}
title: ${params.channel.title}
</project_channel>

<messages>
${content}
</messages>

请用中文简洁总结：已做决定、阻塞点、开放问题和下一步行动。`,
    };
    const options: ChatOptions = {
      system:
        "你是 Lovely Octopus 的 Coordinator。请用中文生成简洁的项目频道摘要，不要使用工具。",
      tools: [],
    };

    let text = "";
    for await (const event of this.llmProvider.chat([userMessage], options)) {
      if (event.type === "text_delta") {
        text += event.text;
      }
    }
    return text.trim() || fallbackProjectSummary(params.messages);
  }
}

export function createCoordinatorTools(context: CoordinatorToolContext): Tool[] {
  const tools = [
    createTaskTool(context),
    createTaskDagTool(context),
    listTasksTool(context),
    assignTaskTool(context),
    delegateTaskTool(context),
    requestApprovalTool(context),
    checkTeamStatusTool(context),
    sendMessageToAgentTool(context),
    postToProjectChannelTool(context),
    summarizeProjectChannelTool(context),
  ];
  if (context.schedules) {
    tools.splice(
      tools.length - 1,
      0,
      createTeamScheduleTool(context),
      listTeamSchedulesTool(context),
      updateTeamScheduleTool(context),
    );
  }
  return tools;
}

export function ensureCoordinatorTools(
  toolRegistry: ToolRegistry,
  context: CoordinatorToolContext,
): void {
  for (const tool of createCoordinatorTools(context)) {
    if (!toolRegistry.get(tool.name)) {
      toolRegistry.register(tool);
    }
  }
}

function createTaskTool(context: CoordinatorToolContext): Tool {
  return {
    name: "create_task",
    description: "Create a Lovely Octopus task through TaskQueue. depends_on is only for prerequisite tasks that must complete successfully before this task starts; do not use depends_on to link retries, reruns, or follow-ups to failed/cancelled tasks.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        project: { type: "string" },
        channel_id: { type: "string" },
        source_message_id: { type: "string" },
        assigned_to: { type: "string" },
        depends_on: { type: "array", items: { type: "string" } },
        due_at: { type: "string" },
      },
      required: ["title", "description"],
    },
    async execute(params) {
      const defaults = context.getTaskDefaults?.();
      const explicitProject = readOptionalString(params.project);
      const project = explicitProject ?? defaults?.project;
      const channelId = resolveTaskChannelId({
        channels: context.channels,
        project,
        explicitChannelId: readOptionalString(params.channel_id),
        defaults,
      });
      const task = context.tasks.createTask({
        title: readRequiredString(params, "title"),
        description: readRequiredString(params, "description"),
        priority: readOptionalNumber(params.priority),
        tags: readStringArray(params.tags, "tags"),
        project,
        channelId,
        sourceMessageId: readOptionalString(params.source_message_id) ?? defaults?.sourceMessageId,
        assignedTo: readOptionalString(params.assigned_to),
        dependsOn: readStringArray(params.depends_on, "depends_on"),
        dueAt: readOptionalString(params.due_at),
        createdBy: "coordinator",
      });
      return okJSON({ task: serializeTask(task) });
    },
  };
}

function createTaskDagTool(context: CoordinatorToolContext): Tool {
  return {
    name: "create_task_dag",
    description:
      "Create a multi-task DAG atomically through TaskQueue. Use this instead of repeated create_task calls whenever one workflow needs several dependent tasks. Each node needs a key; depends_on may reference earlier/later node keys or existing task ids, but only for prerequisite tasks that must complete successfully. Do not use depends_on for retries, reruns, or follow-ups to failed/cancelled tasks.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string" },
        channel_id: { type: "string" },
        source_message_id: { type: "string" },
        active_conflict_tags: { type: "array", items: { type: "string" } },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              priority: { type: "number" },
              tags: { type: "array", items: { type: "string" } },
              project: { type: "string" },
              channel_id: { type: "string" },
              source_message_id: { type: "string" },
              assigned_to: { type: "string" },
              depends_on: { type: "array", items: { type: "string" } },
              due_at: { type: "string" },
            },
            required: ["key", "title", "description"],
          },
        },
      },
      required: ["tasks"],
    },
    async execute(params) {
      const defaults = context.getTaskDefaults?.();
      const project = readOptionalString(params.project) ?? defaults?.project;
      const channelId = resolveTaskChannelId({
        channels: context.channels,
        project,
        explicitChannelId: readOptionalString(params.channel_id),
        defaults,
      });
      const sourceMessageId = readOptionalString(params.source_message_id) ?? defaults?.sourceMessageId;
      const activeConflictTags = readStringArray(params.active_conflict_tags, "active_conflict_tags") ?? [];
      if (activeConflictTags.length > 0) {
        if (!project) {
          throw new Error("project is required when active_conflict_tags is provided.");
        }
        const conflicts = context.tasks
          .listTasks({ project })
          .filter((task) => isActiveTask(task) && activeConflictTags.every((tag) => task.tags.includes(tag)));
        if (conflicts.length > 0) {
          return okJSON({
            created: false,
            reason: "active_conflict",
            active_conflict_tags: activeConflictTags,
            tasks: conflicts.map(serializeTask),
          });
        }
      }

      const taskNodes = readRecordArray(params.tasks, "tasks");
      const tasksToCreate: CreateTaskDagNodeParams[] = taskNodes.map((node) => {
        const nodeProject = readOptionalString(node.project) ?? project;
        const nodeChannelId = resolveTaskChannelId({
          channels: context.channels,
          project: nodeProject,
          explicitChannelId: readOptionalString(node.channel_id) ?? channelId,
          defaults,
        });
        return {
          key: readRequiredString(node, "key"),
          title: readRequiredString(node, "title"),
          description: readRequiredString(node, "description"),
          priority: readOptionalNumber(node.priority),
          tags: readStringArray(node.tags, "tags"),
          project: nodeProject,
          channelId: nodeChannelId,
          sourceMessageId: readOptionalString(node.source_message_id) ?? sourceMessageId,
          assignedTo: readOptionalString(node.assigned_to),
          dependsOn: readStringArray(node.depends_on, "depends_on"),
          dueAt: readOptionalString(node.due_at),
          createdBy: "coordinator",
        };
      });

      const created = context.tasks.createTaskDag(tasksToCreate);
      return okJSON({
        created: true,
        tasks: created.map(serializeTask),
        task_map: Object.fromEntries(
          tasksToCreate.map((node, index) => [node.key, serializeTask(created[index]!)]),
        ),
      });
    },
  };
}

function listTasksTool(context: CoordinatorToolContext): Tool {
  return {
    name: "list_tasks",
    description:
      "List Lovely Octopus tasks with optional filters. Defaults to a compact, limited result to avoid loading large task history into context. Use active_only for conflict checks and mode=\"summary\" for counts only.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string" },
        assigned_to: { type: "string" },
        project: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        active_only: { type: "boolean" },
        mode: { type: "string", enum: ["compact", "summary"] },
        limit: { type: "number" },
      },
    },
    async execute(params) {
      const status = readOptionalTaskStatus(params.status);
      const activeOnly = readOptionalBoolean(params.active_only) ?? false;
      const mode = readOptionalListTasksMode(params.mode) ?? "compact";
      const limit = readListTasksLimit(params.limit);
      let tasks = context.tasks.listTasks({
        status,
        assignedTo: readOptionalString(params.assigned_to),
        project: readOptionalString(params.project),
        tags: readStringArray(params.tags, "tags"),
      });
      if (activeOnly) {
        tasks = tasks.filter(isActiveTask);
      }

      const summary = summarizeTasks(tasks);
      if (mode === "summary") {
        return okJSON({
          mode,
          summary,
          total: tasks.length,
          returned: 0,
          truncated: false,
          tasks: [],
        });
      }

      const visibleTasks = tasks.slice(0, limit);
      return okJSON({
        mode,
        summary,
        total: tasks.length,
        returned: visibleTasks.length,
        limit,
        truncated: visibleTasks.length < tasks.length,
        tasks: visibleTasks.map(serializeTask),
      });
    },
  };
}

function assignTaskTool(context: CoordinatorToolContext): Tool {
  return {
    name: "assign_task",
    description: "Assign a pending task to an agent through TaskQueue.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        agent_name: { type: "string" },
      },
      required: ["task_id", "agent_name"],
    },
    async execute(params) {
      const agentName = readRequiredString(params, "agent_name");
      requireAgent(context.agents, agentName);
      const task = context.tasks.assignTask(readRequiredString(params, "task_id"), agentName);
      return okJSON({ task: serializeTask(task) });
    },
  };
}

function delegateTaskTool(context: CoordinatorToolContext): Tool {
  return {
    name: "delegate_task",
    description: "Create a child task linked to a parent task through TaskQueue. depends_on is only for successful prerequisites; parent_task_id records the delegation relationship and should not be duplicated in depends_on for retries or follow-ups.",
    parameters: {
      type: "object",
      properties: {
        parent_task_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        project: { type: "string" },
        channel_id: { type: "string" },
        assigned_to: { type: "string" },
        depends_on: { type: "array", items: { type: "string" } },
        due_at: { type: "string" },
      },
      required: ["parent_task_id", "title", "description"],
    },
    async execute(params) {
      const assignedTo = readOptionalString(params.assigned_to);
      if (assignedTo) requireAgent(context.agents, assignedTo);
      const parentTaskId = readRequiredString(params, "parent_task_id");
      const parent = context.tasks.getTask(parentTaskId);
      const defaults = context.getTaskDefaults?.();
      const explicitProject = readOptionalString(params.project);
      const project = explicitProject ?? defaults?.project ?? parent?.project;
      const channelId = resolveTaskChannelId({
        channels: context.channels,
        project,
        explicitChannelId: readOptionalString(params.channel_id),
        defaults,
        parent,
      });
      const task = context.tasks.delegateTask(parentTaskId, {
        title: readRequiredString(params, "title"),
        description: readRequiredString(params, "description"),
        priority: readOptionalNumber(params.priority),
        tags: readStringArray(params.tags, "tags"),
        project,
        channelId,
        assignedTo,
        dependsOn: readStringArray(params.depends_on, "depends_on"),
        dueAt: readOptionalString(params.due_at),
        createdBy: "coordinator",
      });
      return okJSON({ task: serializeTask(task) });
    },
  };
}

function requestApprovalTool(context: CoordinatorToolContext): Tool {
  return {
    name: "request_approval",
    description: "Move a running task into awaiting_approval through TaskQueue.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        prompt: { type: "string" },
        data: { type: "object" },
      },
      required: ["task_id", "prompt"],
    },
    async execute(params) {
      const task = context.tasks.requestApproval(readRequiredString(params, "task_id"), {
        prompt: readRequiredString(params, "prompt"),
        data: params.data,
        agentName: "coordinator",
      });
      return okJSON({ task: serializeTask(task) });
    },
  };
}

function checkTeamStatusTool(context: CoordinatorToolContext): Tool {
  return {
    name: "check_team_status",
    description: "Return deterministic status for agents, tasks, and pending team messages.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const agents = ensureAgentsLoaded(context.agents);
      const tasks = context.tasks.listTasks();
      const messages = context.messages.listMessages({ statuses: ["new", "routed", "acked"] });
      const taskCounts = countBy(tasks.map((task) => task.status));
      return okJSON({
        agents: agents.map((agent) => ({
          name: agent.config.name,
          status: agent.config.status,
          runtimeStatus: agent.status,
          taskTags: agent.config.task_tags,
          maxConcurrentTasks: agent.config.max_concurrent_tasks,
        })),
        taskCounts,
        pendingMessages: {
          total: messages.length,
          coordinator: messages.filter((message) => message.channelType === "coordinator").length,
          project: messages.filter((message) => message.channelType === "project").length,
          agentDm: messages.filter((message) => message.channelType === "agent_dm").length,
        },
      });
    },
  };
}

function sendMessageToAgentTool(context: CoordinatorToolContext): Tool {
  return {
    name: "send_message_to_agent",
    description:
      "Send an informal Coordinator DM to an agent by writing TeamMessageStore. Do not use this to assign work; create_task or delegate_task must be used for work that should appear in Tasks. If task_id is provided, it must be an existing full TaskQueue task id.",
    parameters: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        content: { type: "string" },
        priority: { type: "string" },
        task_id: { type: "string" },
      },
      required: ["agent_name", "content"],
    },
    async execute(params) {
      const agentName = readRequiredString(params, "agent_name");
      requireAgent(context.agents, agentName);
      const taskId = readOptionalString(params.task_id);
      assertExistingTaskId(context.tasks, taskId);
      const message = context.messages.createMessage({
        channelType: "agent_dm",
        channelId: agentName,
        taskId,
        senderType: "coordinator",
        senderId: "coordinator",
        content: readRequiredString(params, "content"),
        priority: readPriority(params.priority),
      });
      return okJSON({ message: serializeMessage(message) });
    },
  };
}

function postToProjectChannelTool(context: CoordinatorToolContext): Tool {
  return {
    name: "post_to_project_channel",
    description: "Post a Coordinator message to a project channel through ProjectChannelStore.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string" },
        content: { type: "string" },
        priority: { type: "string" },
        task_id: { type: "string" },
      },
      required: ["project", "content"],
    },
    async execute(params) {
      const taskId = readOptionalString(params.task_id);
      assertExistingTaskId(context.tasks, taskId);
      const message = context.channels.postMessage(readRequiredString(params, "project"), {
        senderType: "coordinator",
        senderId: "coordinator",
        content: readRequiredString(params, "content"),
        priority: readPriority(params.priority),
        taskId,
      });
      return okJSON({ message: serializeMessage(message) });
    },
  };
}

function summarizeProjectChannelTool(context: CoordinatorToolContext): Tool {
  return {
    name: "summarize_project_channel",
    description: "Summarize a project channel and post the summary back to that channel.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string" },
        limit: { type: "number" },
      },
      required: ["project"],
    },
    async execute(params) {
      const project = readRequiredString(params, "project");
      const summary = await summarizeProjectChannel(context, {
        project,
        limit: readOptionalNumber(params.limit),
      });
      return okJSON({ summary: serializeMessage(summary.summaryMessage) });
    },
  };
}

function createTeamScheduleTool(context: CoordinatorToolContext): Tool {
  return {
    name: "create_team_schedule",
    description:
      "Create an internal Lovely Octopus team schedule in TeamScheduleStore. Use this for recurring project reminders or scheduled team work instead of shell, crontab, launchd, Reminders, or other OS-level schedulers.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["cron", "watcher"] },
        name: { type: "string" },
        agent_name: { type: "string" },
        prompt: { type: "string" },
        project: { type: "string" },
        channel_id: { type: "string" },
        cron_expr: {
          type: "string",
          description: 'Required for cron schedules, for example "0 14 * * *" for every day at 14:00 Asia/Shanghai.',
        },
        check_command: { type: "string", description: "Required for watcher schedules." },
        condition: { type: "string" },
        interval_ms: { type: "number" },
        cooldown_ms: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        priority: { type: "number" },
        max_retries: { type: "number" },
        enabled: { type: "boolean" },
      },
      required: ["name", "prompt"],
    },
    async execute(params) {
      const schedules = requireSchedules(context);
      const defaults = context.getTaskDefaults?.();
      const type = readOptionalScheduleType(params.type) ?? "cron";
      const agentName = readOptionalString(params.agent_name) ?? "assistant";
      requireAgent(context.agents, agentName);
      const project = readOptionalString(params.project) ?? defaults?.project;
      const channelId = resolveTaskChannelId({
        channels: context.channels,
        project,
        explicitChannelId: readOptionalString(params.channel_id),
        defaults,
      });

      const schedule = schedules.createSchedule({
        source: "ui",
        type,
        name: readRequiredString(params, "name"),
        agentName,
        prompt: readRequiredString(params, "prompt"),
        project,
        channelId,
        cronExpr: readOptionalString(params.cron_expr),
        checkCommand: readOptionalString(params.check_command),
        condition: readOptionalString(params.condition),
        intervalMs: readOptionalNumber(params.interval_ms),
        cooldownMs: readOptionalNumber(params.cooldown_ms),
        tags: readStringArray(params.tags, "tags") ?? ["scheduled"],
        priority: readOptionalNumber(params.priority),
        maxRetries: readOptionalNumber(params.max_retries),
        enabled: readOptionalBoolean(params.enabled),
      });
      return okJSON({ schedule: serializeSchedule(schedule) });
    },
  };
}

function listTeamSchedulesTool(context: CoordinatorToolContext): Tool {
  return {
    name: "list_team_schedules",
    description: "List internal Lovely Octopus team schedules from TeamScheduleStore.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["cron", "watcher"] },
        agent_name: { type: "string" },
        project: { type: "string" },
        enabled: { type: "boolean" },
        limit: { type: "number" },
      },
    },
    async execute(params) {
      const schedules = requireSchedules(context);
      const rows = schedules.listSchedules({
        type: readOptionalScheduleType(params.type),
        agentName: readOptionalString(params.agent_name),
        project: readOptionalString(params.project),
        enabled: readOptionalBoolean(params.enabled),
        limit: readOptionalNumber(params.limit),
      });
      return okJSON({
        total: rows.length,
        schedules: rows.map(serializeSchedule),
      });
    },
  };
}

function updateTeamScheduleTool(context: CoordinatorToolContext): Tool {
  return {
    name: "update_team_schedule",
    description:
      "Update an internal Lovely Octopus team schedule. Use enabled=false to pause a schedule instead of deleting or changing OS-level schedulers.",
    parameters: {
      type: "object",
      properties: {
        schedule_id: { type: "string" },
        name: { type: "string" },
        agent_name: { type: "string" },
        prompt: { type: "string" },
        project: { type: "string" },
        channel_id: { type: "string" },
        cron_expr: { type: "string" },
        check_command: { type: "string" },
        condition: { type: "string" },
        interval_ms: { type: "number" },
        cooldown_ms: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        priority: { type: "number" },
        max_retries: { type: "number" },
        enabled: { type: "boolean" },
      },
      required: ["schedule_id"],
    },
    async execute(params) {
      const schedules = requireSchedules(context);
      const agentName = readOptionalString(params.agent_name);
      if (agentName) requireAgent(context.agents, agentName);
      const updates: Parameters<TeamScheduleStore["updateSchedule"]>[1] = {};
      if (hasParam(params, "name")) updates.name = readOptionalString(params.name);
      if (hasParam(params, "agent_name")) updates.agentName = agentName;
      if (hasParam(params, "prompt")) updates.prompt = readOptionalString(params.prompt);
      if (hasParam(params, "project")) updates.project = readOptionalString(params.project);
      if (hasParam(params, "channel_id")) {
        updates.channelId = resolveTaskChannelId({
          channels: context.channels,
          project: updates.project,
          explicitChannelId: readOptionalString(params.channel_id),
        });
      }
      if (hasParam(params, "cron_expr")) updates.cronExpr = readOptionalString(params.cron_expr);
      if (hasParam(params, "check_command")) updates.checkCommand = readOptionalString(params.check_command);
      if (hasParam(params, "condition")) updates.condition = readOptionalString(params.condition);
      if (hasParam(params, "interval_ms")) updates.intervalMs = readOptionalNumber(params.interval_ms);
      if (hasParam(params, "cooldown_ms")) updates.cooldownMs = readOptionalNumber(params.cooldown_ms);
      if (hasParam(params, "tags")) updates.tags = readStringArray(params.tags, "tags");
      if (hasParam(params, "priority")) updates.priority = readOptionalNumber(params.priority);
      if (hasParam(params, "max_retries")) updates.maxRetries = readOptionalNumber(params.max_retries);
      if (hasParam(params, "enabled")) updates.enabled = readOptionalBoolean(params.enabled);

      const scheduleId = readRequiredString(params, "schedule_id");
      const schedule = schedules.updateSchedule(scheduleId, updates);
      if (!schedule) {
        throw new Error(`Team schedule not found: ${scheduleId}`);
      }
      return okJSON({ schedule: serializeSchedule(schedule) });
    },
  };
}


export async function summarizeProjectChannel(
  context: CoordinatorToolContext,
  params: { project: string; limit?: number; markResolved?: boolean },
): Promise<{ summaryText: string; summaryMessage: TeamMessage; summarizedMessages: TeamMessage[] }> {
  const channel = requireProjectChannel(context.channels, params.project);
  const messages = context.channels
    .listMessages(channel.slug, params.limit ?? 50)
    .filter((message) => message.senderId !== "coordinator");
  const summaryText = context.llmProvider
    ? await new CoordinatorLLMHelper(context.llmProvider).summarizeProjectChannel({
        channel,
        messages,
      })
    : fallbackProjectSummary(messages);

  const summaryMessage = context.channels.postMessage(channel.slug, {
    senderType: "coordinator",
    senderId: "coordinator",
    content: summaryText,
    priority: "normal",
  });

  if (params.markResolved) {
    for (const message of messages) {
      context.messages.markResolved(message.id, "coordinator");
    }
  }

  return { summaryText, summaryMessage, summarizedMessages: messages };
}

function requireAgent(agents: AgentRegistry, name: string): RegisteredAgent {
  const agent = agents.get(name);
  if (!agent) {
    throw new Error(`Agent not found: ${name}`);
  }
  return agent;
}

function requireProjectChannel(channels: ProjectChannelStore, project: string): ProjectChannel {
  const channel = channels.getChannel(project);
  if (!channel) {
    throw new Error(`Project channel not found: ${project}`);
  }
  return channel;
}

function requireSchedules(context: CoordinatorToolContext): TeamScheduleStore {
  if (!context.schedules) {
    throw new Error("Team schedules are not configured.");
  }
  return context.schedules;
}

function projectChannelId(channels: ProjectChannelStore, project: string | undefined): string | undefined {
  if (!project) return undefined;
  return channels.getChannel(project)?.id;
}

function resolveTaskChannelId(params: {
  channels: ProjectChannelStore;
  project: string | undefined;
  explicitChannelId: string | undefined;
  defaults?: CoordinatorTaskDefaults;
  parent?: Task | null;
}): string | undefined {
  if (params.explicitChannelId) return params.explicitChannelId;
  const channelId = projectChannelId(params.channels, params.project);
  if (channelId) return channelId;
  if (params.project && params.project === params.defaults?.project) return params.defaults.channelId;
  if (params.project && params.project === params.parent?.project) return params.parent.channelId;
  return undefined;
}

function assertExistingTaskId(tasks: TaskQueue, taskId: string | undefined): void {
  if (!taskId) return;
  if (!tasks.getTask(taskId)) {
    throw new Error(
      `Unknown task_id: ${taskId}. Use create_task, create_task_dag, or delegate_task first, then pass the returned full task id.`,
    );
  }
}

function isActiveTask(task: Task): boolean {
  return task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled";
}

function ensureAgentsLoaded(agents: AgentRegistry): RegisteredAgent[] {
  const active = agents.listActive();
  if (active.length > 0) return active;
  return agents.loadAll().filter((agent) => agent.config.status === "active");
}

function okJSON(value: unknown) {
  return { success: true, output: JSON.stringify(value) };
}


function serializeTask(task: Task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignedTo: task.assignedTo,
    tags: task.tags,
    project: task.project,
    channelId: task.channelId,
    sourceMessageId: task.sourceMessageId,
    dependsOn: task.dependsOn,
    dueAt: task.dueAt,
  };
}

function summarizeTasks(tasks: Task[]) {
  return {
    by_status: countTasksBy(tasks, (task) => task.status),
    by_project: countTasksBy(tasks, (task) => task.project ?? "(none)"),
    by_assigned_to: countTasksBy(tasks, (task) => task.assignedTo ?? "(unassigned)"),
    active: tasks.filter(isActiveTask).length,
  };
}

function countTasksBy<T extends string>(items: Task[], keyFor: (task: Task) => T): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const item of items) {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function serializeMessage(message: TeamMessage) {
  return {
    id: message.id,
    channelType: message.channelType,
    channelId: message.channelId,
    project: message.project,
    taskId: message.taskId,
    senderType: message.senderType,
    senderId: message.senderId,
    content: message.content,
    status: message.status,
  };
}

function serializeSchedule(schedule: TeamSchedule) {
  return {
    id: schedule.id,
    source: schedule.source,
    type: schedule.type,
    name: schedule.name,
    agentName: schedule.agentName,
    prompt: schedule.prompt,
    project: schedule.project,
    channelId: schedule.channelId,
    tags: schedule.tags,
    priority: schedule.priority,
    maxRetries: schedule.maxRetries,
    enabled: schedule.enabled,
    cronExpr: schedule.cronExpr,
    checkCommand: schedule.checkCommand,
    condition: schedule.condition,
    intervalMs: schedule.intervalMs,
    cooldownMs: schedule.cooldownMs,
    lastRunAt: schedule.lastRunAt,
    nextRunAt: schedule.nextRunAt,
    lastTaskId: schedule.lastTaskId,
    lastStatus: schedule.lastStatus,
    lastError: schedule.lastError,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

function readRequiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error("Expected optional string value.");
  }
  return value;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected optional number value.");
  }
  return value;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error("Expected optional boolean value.");
  }
  return value;
}

function readOptionalListTasksMode(value: unknown): "compact" | "summary" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "compact" || value === "summary") return value;
  throw new Error('mode must be "compact" or "summary".');
}

function readOptionalScheduleType(value: unknown): TeamScheduleType | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "cron" || value === "watcher") return value;
  throw new Error('type must be "cron" or "watcher".');
}

function readListTasksLimit(value: unknown): number {
  const limit = readOptionalNumber(value) ?? LIST_TASKS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer.");
  }
  return Math.min(limit, LIST_TASKS_MAX_LIMIT);
}

function readStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value;
}

function readRecordArray(value: unknown, key: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    throw new Error(`${key} must be an array of objects.`);
  }
  return value as Array<Record<string, unknown>>;
}

function readOptionalTaskStatus(value: unknown): TaskStatus | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value === "pending" ||
    value === "assigned" ||
    value === "running" ||
    value === "awaiting_approval" ||
    value === "approved" ||
    value === "rejected" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error(`Invalid task status: ${String(value)}`);
}

function readPriority(value: unknown): TeamMessagePriority {
  if (value === undefined || value === null || value === "") return "normal";
  if (value === "low" || value === "normal" || value === "high" || value === "urgent") {
    return value;
  }
  throw new Error(`Invalid message priority: ${String(value)}`);
}

function hasParam(params: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, key);
}

function countBy(items: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item] = (counts[item] ?? 0) + 1;
  }
  return counts;
}

function formatProjectMessagesForSummary(messages: TeamMessage[]): string {
  if (messages.length === 0) return "(none)";
  return messages
    .map((message) => `- ${message.createdAt} ${message.senderId}: ${message.content}`)
    .join("\n");
}

function fallbackProjectSummary(messages: TeamMessage[]): string {
  if (messages.length === 0) {
    return "没有需要总结的项目频道消息。";
  }
  const latest = messages.slice(-5).map((message) => `${message.senderId}: ${message.content}`);
  return `基于 ${messages.length} 条项目消息的摘要：\n${latest.join("\n")}`;
}
