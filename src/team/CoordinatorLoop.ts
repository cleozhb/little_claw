import { createAgentConfig } from "../agents/AgentConfig.ts";
import { AgentLoop } from "../core/AgentLoop.ts";
import { EphemeralConversation } from "../core/EphemeralConversation.ts";
import type { ContextRetriever } from "../memory/ContextRetriever.ts";
import type { MemoryManager } from "../memory/MemoryManager.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { SkillManager } from "../skills/SkillManager.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { ShellTool } from "../tools/types.ts";
import { createLogger } from "../utils/logger.ts";
import type { AgentRegistry, RegisteredAgent } from "./AgentRegistry.ts";
import {
  COORDINATOR_TOOL_NAMES,
  ensureCoordinatorTools,
  summarizeProjectChannel,
} from "./CoordinatorTools.ts";
import type { ProjectChannelStore } from "./ProjectChannelStore.ts";
import type { Task, TaskQueue } from "./TaskQueue.ts";
import type { TeamMessageStore, TeamMessage } from "./TeamMessageStore.ts";

const log = createLogger("CoordinatorLoop");
const DEFAULT_COORDINATOR_CHANNEL_ID = "default";

export interface CoordinatorLoopOptions {
  agents: AgentRegistry;
  tasks: TaskQueue;
  messages: TeamMessageStore;
  channels: ProjectChannelStore;
  llmProvider: LLMProvider;
  toolRegistry: ToolRegistry;
  skillManager?: SkillManager;
  shellTool?: ShellTool;
  memoryManager?: MemoryManager;
  contextRetriever?: ContextRetriever;
  pollIntervalMs?: number;
  maxTurns?: number;
  projectSummaryThreshold?: number;
  coordinatorName?: string;
}

export type CoordinatorLoopState = "idle" | "running" | "stopped";

/**
 * Coordinator scheduler for Lovely Octopus team mode.
 *
 * The loop owns scanning, deterministic assignment, timeout escalation, and
 * context assembly. When coordination needs actual multi-turn reasoning or
 * tool use, it runs the coordinator as a normal AgentLoop with CoordinatorTools.
 */
export class CoordinatorLoop {
  private agents: AgentRegistry;
  private tasks: TaskQueue;
  private messages: TeamMessageStore;
  private channels: ProjectChannelStore;
  private llmProvider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private skillManager?: SkillManager;
  private shellTool?: ShellTool;
  private memoryManager?: MemoryManager;
  private contextRetriever?: ContextRetriever;
  private pollIntervalMs: number;
  private maxTurns: number;
  private projectSummaryThreshold: number;
  private coordinatorName: string;

  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private currentLoop: AgentLoop | null = null;
  private stateValue: CoordinatorLoopState = "idle";

  constructor(options: CoordinatorLoopOptions) {
    this.agents = options.agents;
    this.tasks = options.tasks;
    this.messages = options.messages;
    this.channels = options.channels;
    this.llmProvider = options.llmProvider;
    this.toolRegistry = options.toolRegistry;
    this.skillManager = options.skillManager;
    this.shellTool = options.shellTool;
    this.memoryManager = options.memoryManager;
    this.contextRetriever = options.contextRetriever;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.maxTurns = options.maxTurns ?? 10;
    this.projectSummaryThreshold = options.projectSummaryThreshold ?? 10;
    this.coordinatorName = options.coordinatorName ?? "coordinator";

    ensureCoordinatorTools(this.toolRegistry, {
      tasks: this.tasks,
      messages: this.messages,
      channels: this.channels,
      agents: this.agents,
      llmProvider: this.llmProvider,
    });
  }

  get state(): CoordinatorLoopState {
    return this.stateValue;
  }

  get isRunning(): boolean {
    return this.currentLoop?.isRunning ?? false;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.currentLoop?.abort();
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.stateValue = "stopped";
  }

  async tick(): Promise<void> {
    if (this.currentLoop?.isRunning) return;

    this.stateValue = "running";
    try {
      this.failTimedOutTasks();
      this.escalateFailedTasks();
      this.assignPendingTasks();
      await this.summarizeBusyProjectChannels();
      await this.handleCoordinatorInbox();
    } finally {
      this.stateValue = "idle";
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      if (!this.stopped) {
        await sleep(this.pollIntervalMs);
      }
    }
  }

  private assignPendingTasks(): void {
    const agents = this.listAssignableAgents();
    for (const agent of agents) {
      const candidates = this.tasks.getPendingForAgent(agent);
      for (const task of candidates) {
        const latest = this.tasks.getTask(task.id);
        if (!latest || latest.status !== "pending") continue;
        if (latest.tags.length > 0 && !hasOverlap(latest.tags, agent.config.task_tags)) continue;
        log.step("Coordinator deterministically assigned pending task", {
          taskId: latest.id,
          agent: agent.config.name,
          tags: latest.tags,
        });
        this.tasks.assignTask(latest.id, agent.config.name);
      }
    }
  }

  private failTimedOutTasks(): void {
    const running = this.tasks.listTasks({ status: "running" });
    const now = Date.now();
    for (const task of running) {
      if (!task.startedAt || !task.assignedTo) continue;
      const agent = this.agents.get(task.assignedTo);
      const timeoutMinutes = agent?.config.timeout_minutes ?? 30;
      const startedAt = Date.parse(task.startedAt);
      if (!Number.isFinite(startedAt)) continue;
      const elapsedMs = now - startedAt;
      if (elapsedMs < timeoutMinutes * 60_000) continue;

      log.warn(
        `Coordinator detected timed out task ${task.id}`,
        `assignedTo=${task.assignedTo} elapsedMs=${elapsedMs}`,
      );
      this.tasks.failTask(
        task.id,
        `Task timed out after ${timeoutMinutes} minute(s).`,
        this.coordinatorName,
      );
    }
  }

  private escalateFailedTasks(): void {
    for (const task of this.tasks.listTasks({ status: "failed" })) {
      if (this.hasCoordinatorEscalation(task.id)) continue;
      const content = `Task ${task.id} failed and needs coordinator attention.\nTitle: ${task.title}\nError: ${task.error ?? "(none)"}`;
      this.messages.createMessage({
        channelType: "coordinator",
        channelId: DEFAULT_COORDINATOR_CHANNEL_ID,
        taskId: task.id,
        senderType: "system",
        senderId: "task-queue",
        content,
        priority: "high",
      });
    }
  }

  private async summarizeBusyProjectChannels(): Promise<void> {
    for (const channel of this.channels.listChannels({ status: "active" })) {
      const pending = this.messages.getPendingForProject(channel.slug, this.projectSummaryThreshold);
      if (pending.length < this.projectSummaryThreshold) continue;
      if (pending.some((message) => message.senderId === this.coordinatorName)) continue;

      log.step("Coordinator summarizing busy project channel", {
        project: channel.slug,
        pendingMessages: pending.length,
      });
      await summarizeProjectChannel(
        {
          tasks: this.tasks,
          messages: this.messages,
          channels: this.channels,
          agents: this.agents,
          llmProvider: this.llmProvider,
        },
        {
          project: channel.slug,
          limit: this.projectSummaryThreshold,
          markResolved: true,
        },
      );
    }
  }

  private async handleCoordinatorInbox(): Promise<void> {
    const pendingMessages = this.messages.listMessages({
      channelType: "coordinator",
      channelId: DEFAULT_COORDINATOR_CHANNEL_ID,
      statuses: ["new", "routed", "acked"],
      limit: 20,
    }).filter((message) => message.senderId !== this.coordinatorName);
    if (pendingMessages.length === 0) return;

    const coordinator = this.requireCoordinatorAgent();
    const conversation = new EphemeralConversation("Lovely Octopus coordinator execution.");
    const loop = new AgentLoop(this.llmProvider, this.toolRegistry, conversation, {
      config: createAgentConfig({
        name: coordinator.config.name,
        systemPrompt: buildCoordinatorSystemPrompt(coordinator),
        allowedTools: uniqueStrings([
          ...coordinator.config.tools,
          ...COORDINATOR_TOOL_NAMES,
        ]),
        maxTurns: this.maxTurns,
        canSpawnSubAgent: false,
      }),
      skillManager: this.skillManager,
      shellTool: this.shellTool,
      memoryManager: this.memoryManager,
      contextRetriever: this.contextRetriever,
    });

    for (const message of pendingMessages) {
      this.messages.markInjected(message.id, this.coordinatorName);
    }

    this.currentLoop = loop;
    let assistantText = "";
    try {
      for await (const event of loop.run(buildCoordinatorUserPrompt({
        messages: pendingMessages,
        tasks: this.tasks.listTasks({ limit: 20 }),
        agents: this.listActiveAgents(),
      }))) {
        if (event.type === "text_delta") {
          assistantText += event.text;
        }
      }
    } finally {
      this.currentLoop = null;
    }

    if (assistantText.trim()) {
      this.messages.createMessage({
        channelType: "coordinator",
        channelId: DEFAULT_COORDINATOR_CHANNEL_ID,
        senderType: "coordinator",
        senderId: this.coordinatorName,
        content: assistantText.trim(),
      });
    }
  }

  private requireCoordinatorAgent(): RegisteredAgent {
    const agent = this.agents.get(this.coordinatorName);
    if (!agent || agent.config.status !== "active") {
      throw new Error(`Active coordinator agent not found: ${this.coordinatorName}`);
    }
    return agent;
  }

  private listActiveAgents(): RegisteredAgent[] {
    const active = this.agents.listActive();
    if (active.length > 0) return active;
    return this.agents.loadAll().filter((agent) => agent.config.status === "active");
  }

  private listAssignableAgents(): RegisteredAgent[] {
    return this.listActiveAgents().filter((agent) => agent.config.name !== this.coordinatorName);
  }

  private hasCoordinatorEscalation(taskId: string): boolean {
    return this.messages
      .listMessages({
        channelType: "coordinator",
        channelId: DEFAULT_COORDINATOR_CHANNEL_ID,
        taskId,
        limit: 100,
      })
      .some((message) => message.senderId === "task-queue" || message.senderId === this.coordinatorName);
  }
}

export function buildCoordinatorSystemPrompt(agent: RegisteredAgent): string {
  return `<agent_soul>
${agent.soul.trim()}
</agent_soul>

<agent_operating_instructions>
${agent.operatingInstructions.trim()}
</agent_operating_instructions>

<coordinator_boundaries>
You are a coordinator, not the human's boss and not the only team entrypoint.
Use CoordinatorTools for task and message facts. Do not bypass TaskQueue or TeamMessageStore.
Prefer deterministic assignment and status checks when they are enough.
</coordinator_boundaries>`;
}

export function buildCoordinatorUserPrompt(params: {
  messages: TeamMessage[];
  tasks: Task[];
  agents: RegisteredAgent[];
}): string {
  return `<coordinator_context>
pending_coordinator_messages:
${formatMessages(params.messages)}

recent_tasks:
${formatTasks(params.tasks)}

active_agents:
${formatAgents(params.agents)}
</coordinator_context>`;
}

function formatMessages(messages: TeamMessage[]): string {
  if (messages.length === 0) return "(none)";
  return messages
    .map((message) => `- ${message.id} [${message.senderType}:${message.senderId}] ${message.content}`)
    .join("\n");
}

function formatTasks(tasks: Task[]): string {
  if (tasks.length === 0) return "(none)";
  return tasks
    .map((task) => {
      const assigned = task.assignedTo ? ` assigned=${task.assignedTo}` : "";
      const tags = task.tags.length > 0 ? ` tags=${task.tags.join(",")}` : "";
      return `- ${task.id} status=${task.status}${assigned}${tags}: ${task.title}`;
    })
    .join("\n");
}

function formatAgents(agents: RegisteredAgent[]): string {
  if (agents.length === 0) return "(none)";
  return agents
    .map((agent) => `- ${agent.config.name}: tags=${agent.config.task_tags.join(",") || "(none)"}`)
    .join("\n");
}

function hasOverlap(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function uniqueStrings(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
