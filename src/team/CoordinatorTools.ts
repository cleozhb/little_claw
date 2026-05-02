import type { ChatOptions, LLMProvider } from "../llm/types.ts";
import type { Message } from "../types/message.ts";
import type { Tool } from "../tools/types.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { AgentRegistry, RegisteredAgent } from "./AgentRegistry.ts";
import type { ProjectChannel, ProjectChannelStore } from "./ProjectChannelStore.ts";
import type { Task, TaskQueue, TaskStatus } from "./TaskQueue.ts";
import type { TeamMessageStore, TeamMessage, TeamMessagePriority } from "./TeamMessageStore.ts";

export const COORDINATOR_TOOL_NAMES = [
  "create_task",
  "list_tasks",
  "assign_task",
  "delegate_task",
  "request_approval",
  "check_team_status",
  "send_message_to_agent",
  "post_to_project_channel",
  "summarize_project_channel",
] as const;

export type CoordinatorToolName = (typeof COORDINATOR_TOOL_NAMES)[number];

export interface CoordinatorToolContext {
  tasks: TaskQueue;
  messages: TeamMessageStore;
  channels: ProjectChannelStore;
  agents: AgentRegistry;
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

Summarize decisions, blockers, open questions, and next actions. Keep it concise.`,
    };
    const options: ChatOptions = {
      system:
        "You are the Lovely Octopus Coordinator. Produce a concise project channel summary. Do not use tools.",
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
  return [
    createTaskTool(context),
    listTasksTool(context),
    assignTaskTool(context),
    delegateTaskTool(context),
    requestApprovalTool(context),
    checkTeamStatusTool(context),
    sendMessageToAgentTool(context),
    postToProjectChannelTool(context),
    summarizeProjectChannelTool(context),
  ];
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
    description: "Create a Lovely Octopus task through TaskQueue.",
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

function listTasksTool(context: CoordinatorToolContext): Tool {
  return {
    name: "list_tasks",
    description: "List Lovely Octopus tasks with optional filters.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string" },
        assigned_to: { type: "string" },
        project: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
      },
    },
    async execute(params) {
      const status = readOptionalTaskStatus(params.status);
      const tasks = context.tasks.listTasks({
        status,
        assignedTo: readOptionalString(params.assigned_to),
        project: readOptionalString(params.project),
        tags: readStringArray(params.tags, "tags"),
        limit: readOptionalNumber(params.limit),
      });
      return okJSON({ tasks: tasks.map(serializeTask) });
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
    description: "Create a child task linked to a parent task through TaskQueue.",
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
      `Unknown task_id: ${taskId}. Use create_task or delegate_task first, then pass the returned full task id.`,
    );
  }
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
    dueAt: task.dueAt,
  };
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

function readStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value;
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
    return "No project channel messages to summarize.";
  }
  const latest = messages.slice(-5).map((message) => `${message.senderId}: ${message.content}`);
  return `Project summary based on ${messages.length} messages:\n${latest.join("\n")}`;
}
