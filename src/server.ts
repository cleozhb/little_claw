/**
 * src/server.ts — Gateway Server 入口
 *
 * 启动 Database、ToolRegistry、SkillManager、SessionRouter、GatewayServer。
 * 用法: bun run src/server.ts
 */

import { loadConfig } from "./config/index.ts";
import { createProvider } from "./llm/index.ts";
import { ToolRegistry } from "./tools/ToolRegistry.ts";
import { createBuiltinTools } from "./tools/builtin/index.ts";
import { createSpawnAgentTool } from "./tools/builtin/SpawnAgentTool.ts";
import type { SpawnAgentTool } from "./tools/builtin/SpawnAgentTool.ts";
import { Database } from "./db/Database.ts";
import { SessionRouter } from "./gateway/SessionRouter.ts";
import { GatewayServer } from "./gateway/GatewayServer.ts";
import { SkillManager } from "./skills/SkillManager.ts";
import { SkillLoader } from "./skills/SkillLoader.ts";
import { SkillConfigFile } from "./skills/SkillConfigFile.ts";
import { McpManager } from "./mcp/McpManager.ts";
import { CronScheduler } from "./scheduler/CronScheduler.ts";
import { EventWatcher } from "./scheduler/EventWatcher.ts";
import type { SchedulerEvent } from "./scheduler/types.ts";
import { VectorStore } from "./memory/VectorStore.ts";
import { MemoryManager } from "./memory/MemoryManager.ts";
import { createEmbeddingProvider } from "./memory/EmbeddingProvider.ts";
import { FileMemoryManager } from "./memory/FileMemoryManager.ts";
import { createMemoryWriteTool } from "./tools/builtin/MemoryWriteTool.ts";
import { createMemoryReadTool } from "./tools/builtin/MemoryReadTool.ts";
import { createContextWriteTool } from "./tools/builtin/ContextWriteTool.ts";
import { ContextIndexer } from "./memory/ContextIndexer.ts";
import { ContextRetriever } from "./memory/ContextRetriever.ts";
import { ContextMetaGenerator } from "./memory/ContextMetaGenerator.ts";
import { SimulationManager } from "./simulation/SimulationManager.ts";
import { FeishuAdapter } from "./gateway/adapters/FeishuAdapter.ts";
import { AgentRegistry, type RegisteredAgent } from "./team/AgentRegistry.ts";
import { TaskQueue } from "./team/TaskQueue.ts";
import { TeamMessageStore } from "./team/TeamMessageStore.ts";
import { ProjectChannelStore } from "./team/ProjectChannelStore.ts";
import { createAgentWorkers, type AgentWorker } from "./team/AgentWorker.ts";
import { CoordinatorLoop } from "./team/CoordinatorLoop.ts";
import { TeamRouter } from "./team/TeamRouter.ts";
import type { LLMProvider } from "./llm/types.ts";
import type { ShellTool } from "./tools/types.ts";
import type { MemoryManager as MemoryManagerType } from "./memory/MemoryManager.ts";
import type { ContextRetriever as ContextRetrieverType } from "./memory/ContextRetriever.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/** 用 AsyncLocalStorage 传递当前 sessionId，避免跨 session 并发时共享变量竞态 */
const sessionIdStorage = new AsyncLocalStorage<string>();

export interface LovelyOctopusRuntimeOptions {
  db: Database;
  llmProvider: LLMProvider;
  toolRegistry: ToolRegistry;
  skillManager?: SkillManager;
  shellTool?: ShellTool;
  memoryManager?: MemoryManagerType;
  contextRetriever?: ContextRetrieverType;
  agentDir?: string;
  workerPollIntervalMs?: number;
  coordinatorPollIntervalMs?: number;
}

export interface LovelyOctopusRuntimeStatus {
  registeredAgents: number;
  activeAgents: number;
  projectChannels: number;
  tasks: {
    pending: number;
    running: number;
    awaitingApproval: number;
  };
  loadErrors: number;
}

export interface LovelyOctopusRuntime {
  agentRegistry: AgentRegistry;
  registeredAgents: RegisteredAgent[];
  teamMessages: TeamMessageStore;
  projectChannels: ProjectChannelStore;
  taskQueue: TaskQueue;
  agentWorkers: AgentWorker[];
  coordinatorLoop: CoordinatorLoop;
  teamRouter: TeamRouter;
  start(): void;
  stop(): Promise<void>;
  getStatus(): LovelyOctopusRuntimeStatus;
}

export function createLovelyOctopusRuntime(options: LovelyOctopusRuntimeOptions): LovelyOctopusRuntime {
  const agentRegistry = new AgentRegistry(options.agentDir);
  let registeredAgents = agentRegistry.loadAll();
  if (registeredAgents.length === 0) {
    console.log("Lovely Octopus: no agents found, creating default coordinator and coder templates");
    for (const name of ["coordinator", "coder"]) {
      try {
        agentRegistry.createFromTemplate(name);
      } catch (err) {
        console.error(
          `Lovely Octopus: failed to create default agent ${name}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    registeredAgents = agentRegistry.loadAll();
  }

  const teamMessages = new TeamMessageStore(options.db);
  const projectChannels = new ProjectChannelStore(options.db, teamMessages);
  const taskQueue = new TaskQueue(options.db);
  const agentWorkers = createAgentWorkers(agentRegistry.listActive(), {
    tasks: taskQueue,
    messages: teamMessages,
    llmProvider: options.llmProvider,
    toolRegistry: options.toolRegistry,
    skillManager: options.skillManager,
    shellTool: options.shellTool,
    memoryManager: options.memoryManager,
    contextRetriever: options.contextRetriever,
    pollIntervalMs: options.workerPollIntervalMs,
  });
  const coordinatorLoop = new CoordinatorLoop({
    agents: agentRegistry,
    tasks: taskQueue,
    messages: teamMessages,
    channels: projectChannels,
    llmProvider: options.llmProvider,
    toolRegistry: options.toolRegistry,
    skillManager: options.skillManager,
    shellTool: options.shellTool,
    memoryManager: options.memoryManager,
    contextRetriever: options.contextRetriever,
    pollIntervalMs: options.coordinatorPollIntervalMs,
  });
  const teamRouter = new TeamRouter({
    agentRegistry,
    taskQueue,
    messages: teamMessages,
    projectChannels,
  });

  let started = false;

  return {
    agentRegistry,
    registeredAgents,
    teamMessages,
    projectChannels,
    taskQueue,
    agentWorkers,
    coordinatorLoop,
    teamRouter,
    start() {
      if (started) return;
      started = true;
      for (const worker of agentWorkers) {
        worker.start();
      }
      coordinatorLoop.start();
    },
    async stop() {
      if (!started) return;
      started = false;
      await Promise.all(agentWorkers.map((worker) => worker.stop()));
      await coordinatorLoop.stop();
    },
    getStatus() {
      return getLovelyOctopusRuntimeStatus(
        agentRegistry,
        registeredAgents,
        projectChannels,
        taskQueue,
      );
    },
  };
}

export function formatLovelyOctopusStatus(status: LovelyOctopusRuntimeStatus): string {
  const loadErrorText = status.loadErrors > 0
    ? `, load_errors=${status.loadErrors}`
    : "";
  return (
    `Lovely Octopus: ${status.activeAgents}/${status.registeredAgents} active agents, ` +
    `${status.projectChannels} project channels, ` +
    `tasks pending=${status.tasks.pending} running=${status.tasks.running} awaiting_approval=${status.tasks.awaitingApproval}` +
    loadErrorText
  );
}

function getLovelyOctopusRuntimeStatus(
  agentRegistry: AgentRegistry,
  registeredAgents: RegisteredAgent[],
  projectChannels: ProjectChannelStore,
  taskQueue: TaskQueue,
): LovelyOctopusRuntimeStatus {
  return {
    registeredAgents: registeredAgents.length,
    activeAgents: agentRegistry.listActive().length,
    projectChannels: projectChannels.listChannels().length,
    tasks: {
      pending: taskQueue.listTasks({ status: "pending" }).length,
      running: taskQueue.listTasks({ status: "running" }).length,
      awaitingApproval: taskQueue.listTasks({ status: "awaiting_approval" }).length,
    },
    loadErrors: agentRegistry.getLoadErrors().length,
  };
}

export async function startServer(): Promise<{ gateway: GatewayServer; cleanup: () => Promise<void> }> {
  const config = loadConfig();

  if (!config.llmApiKey) {
    console.error("Error: LLM_API_KEY is not set in .env");
    process.exit(1);
  }

  const host = process.env.GATEWAY_HOST ?? "localhost";
  const port = parseInt(process.env.GATEWAY_PORT ?? "4000", 10);

  console.log(
    `Provider: ${config.llmProvider}, Model: ${config.llmModel}, BaseURL: ${config.llmBaseUrl ?? "(default)"}`,
  );

  const llmProvider = createProvider({
    provider: config.llmProvider,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    baseURL: config.llmBaseUrl,
  });

  const dataDir = join(import.meta.dir, "..", "data");
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "little_claw.db"));

  // --- Memory 系统初始化 ---
  const embeddingProvider = createEmbeddingProvider({
    apiKey: process.env.EMBEDDING_API_KEY ?? config.llmApiKey,
    model: process.env.EMBEDDING_MODEL,
    baseURL: process.env.EMBEDDING_BASE_URL,
  });
  const vectorStore = new VectorStore(join(dataDir, "memory.db"), embeddingProvider);

  // 文件记忆层初始化（~/.little_claw/ 下的 SOUL.md, USER.md, memory/）
  const fileMemory = new FileMemoryManager();
  await fileMemory.initialize();

  const memoryManager = new MemoryManager(vectorStore, llmProvider, db, fileMemory);

  // --- Context Hub: 自动补全元文件 + 索引 + 检索 ---
  const contextHub = fileMemory.getContextHub();
  const contextMetaGenerator = new ContextMetaGenerator(contextHub, llmProvider);
  const contextIndexer = new ContextIndexer(db, embeddingProvider, contextHub);
  const contextRetriever = new ContextRetriever(db, embeddingProvider);

  // 启动时补全缺失的 .abstract.md / .overview.md（fire-and-forget），随后建索引
  contextMetaGenerator
    .scanAndGenerate()
    .then(({ generated }) => {
      if (generated > 0) {
        console.log(`Context Hub: generated ${generated} meta file(s)`);
      }
      return contextIndexer.indexAll();
    })
    .then(() => {
      const count = db.getAllContextIndex().length;
      console.log(`Context Hub: ${count} overview(s) indexed`);
    })
    .catch((err) => {
      console.error("Context Hub init failed:", err instanceof Error ? err.message : String(err));
    });

  // --- Scheduler 系统初始化 ---
  const cronScheduler = new CronScheduler(db);
  const eventWatcher = new EventWatcher(db);

  const toolRegistry = new ToolRegistry();
  const workspaceRoot = join(process.cwd(), "workspace");
  mkdirSync(workspaceRoot, { recursive: true });

  /** 从 AsyncLocalStorage 读取当前 sessionId，跨 session 并发安全 */
  const getSessionId = () => sessionIdStorage.getStore() ?? "";

  const builtinTools = createBuiltinTools(workspaceRoot, {
    cronContext: {
      scheduler: cronScheduler,
      getSessionId,
    },
    watcherContext: {
      watcher: eventWatcher,
      getSessionId,
    },
  });
  for (const tool of builtinTools.all) {
    toolRegistry.register(tool);
  }

  // --- 记忆工具注册 ---
  toolRegistry.register(createMemoryWriteTool(fileMemory, vectorStore));
  toolRegistry.register(createMemoryReadTool(fileMemory));
  toolRegistry.register(createContextWriteTool(fileMemory, contextIndexer));

  // --- SpawnAgentTool 注册（只有 Main Agent 会在工具列表中看到它） ---
  const spawnAgentTool = createSpawnAgentTool({
    llmProvider,
    toolRegistry,
  });
  toolRegistry.register(spawnAgentTool);

  // --- Skill 系统初始化 ---
  const skillConfig = new SkillConfigFile();
  await skillConfig.load();

  const skillLoader = new SkillLoader();
  const skillManager = new SkillManager(skillLoader, skillConfig, {
    db,
    embeddingProvider,
  });
  await skillManager.initializeAll();

  // 打印 Skill 加载摘要
  const skillSummary = skillManager.getSummary();

  // --- MCP 系统初始化 ---
  const mcpManager = new McpManager(toolRegistry);
  await mcpManager.connectAll();

  // --- 启动摘要 ---
  const builtinCount = builtinTools.all.length;
  const allTools = toolRegistry.getAll();
  const mcpToolCount = allTools.filter((t) => t.name.startsWith("mcp.")).length;
  const skillToolCount = allTools.length - builtinCount - mcpToolCount;

  const mcpStatus = mcpManager.getStatus();
  const mcpConnected = mcpStatus.filter((s) => s.status === "connected");

  const toolLine = [
    `${builtinCount} built-in`,
    skillToolCount > 0 ? `${skillToolCount} from skills` : null,
    mcpToolCount > 0 ? `${mcpToolCount} from MCP (${mcpConnected.length} server${mcpConnected.length !== 1 ? "s" : ""})` : null,
  ].filter(Boolean).join(", ");

  if (skillSummary.total > 0) {
    const parts = [`${skillSummary.loaded} loaded`];
    if (skillSummary.unavailable > 0) parts.push(`${skillSummary.unavailable} unavailable`);
    if (skillSummary.disabled > 0) parts.push(`${skillSummary.disabled} disabled`);
    if (skillSummary.error > 0) parts.push(`${skillSummary.error} error`);
    console.log(`Skills: ${parts.join(", ")}`);

    for (const detail of skillManager.getUnavailableDetails()) {
      console.log(`  ${detail.name}: ${detail.missing}`);
    }
  }

  if (mcpConnected.length > 0) {
    const serverDetails = mcpConnected
      .map((s) => `${s.name} (${s.toolCount} tools)`)
      .join(", ");
    console.log(`MCP: ${serverDetails}`);
  }

  console.log(`Tools: ${toolLine}`);

  // 打印记忆状态
  const memoryCount = vectorStore.getCount();
  const memoryBySession = vectorStore.getCountBySession();
  console.log(`Memory: ${memoryCount} entries across ${memoryBySession.length} sessions`);

  // --- Simulation 系统初始化 ---
  const simulationManager = new SimulationManager({
    llmProvider,
    toolRegistry,
    skillManager,
  });
  await simulationManager.initialize();

  const personaCount = simulationManager.listPersonas().length;
  const scenarioCount = simulationManager.listScenarios().length;
  console.log(`Simulation: ${personaCount} personas, ${scenarioCount} scenarios`);

  // --- 飞书 IM 适配器初始化 ---
  let feishuAdapter: FeishuAdapter | undefined;
  if (config.feishu?.enabled) {
    feishuAdapter = new FeishuAdapter(config.feishu);
    console.log(`Feishu: webhook enabled (app_id: ${config.feishu.appId})`);
  }

  const sessionRouter = new SessionRouter({
    db,
    llmProvider,
    toolRegistry,
    skillManager,
    shellTool: builtinTools.shellTool,
    spawnAgentTool,
    memoryManager,
    contextRetriever,
  });

  const lovelyOctopus = createLovelyOctopusRuntime({
    db,
    llmProvider,
    toolRegistry,
    skillManager,
    shellTool: builtinTools.shellTool,
    memoryManager,
    contextRetriever,
  });

  const agentLoadErrors = lovelyOctopus.agentRegistry.getLoadErrors();
  if (agentLoadErrors.length > 0) {
    console.warn(`Lovely Octopus: ${agentLoadErrors.length} agent config error(s) isolated`);
    for (const error of agentLoadErrors) {
      console.warn(`  ${error.name}: ${error.message}`);
    }
  }

  console.log(formatLovelyOctopusStatus(lovelyOctopus.getStatus()));

  const gateway = new GatewayServer({
    port,
    hostname: host,
    db,
    toolRegistry,
    llmProvider,
    skillManager,
    mcpManager,
    cronScheduler,
    eventWatcher,
    memoryManager,
    contextRetriever,
    contextIndexer,
    contextMetaGenerator,
    simulationManager,
    feishuAdapter,
    teamRouter: lovelyOctopus.teamRouter,
    teamMessages: lovelyOctopus.teamMessages,
    projectChannels: lovelyOctopus.projectChannels,
    taskQueue: lovelyOctopus.taskQueue,
    onSessionSwitch: (oldSessionId) => {
      sessionRouter.saveMemoryForSession(oldSessionId);
    },
    onChat: (connectionId, sessionId, content) => {
      sessionIdStorage.run(sessionId, () => {
        sessionRouter
          .handleChat(sessionId, content, (event) => {
            gateway.sendToConnection(connectionId, event);
          })
          .catch((err) => {
            gateway.sendToConnection(connectionId, {
              type: "error",
              sessionId,
              message: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
      });
    },
    onWebhookChat: (sessionId, content) => {
      return new Promise<string>((resolve, reject) => {
        sessionIdStorage.run(sessionId, () => {
          let fullText = "";
          sessionRouter
            .handleChat(sessionId, content, (event) => {
              if (event.type === "text_delta") {
                fullText += event.text;
              }
            })
            .then(() => resolve(fullText))
            .catch(reject);
        });
      });
    },
    onAbort: (sessionId) => {
      return sessionRouter.abortSession(sessionId);
    },
    onInject: (sessionId, content) => {
      return sessionRouter.injectMessage(sessionId, content);
    },
    getActiveSessionCount: () => sessionRouter.getActiveSessionCount(),
  });

  lovelyOctopus.start();
  gateway.start();

  // --- Scheduler → Agent 触发回调 ---
  const handleSchedulerTrigger = (event: SchedulerEvent) => {
    const sessionId =
      event.type === "cron_trigger" ? event.job.sessionId : event.watcher.sessionId;
    const name =
      event.type === "cron_trigger" ? event.job.name : event.watcher.name;
    const source = event.type === "cron_trigger" ? "cron" as const : "watcher" as const;
    const prompt =
      event.type === "cron_trigger"
        ? event.job.prompt
        : `${event.watcher.prompt}\n\nCheck output:\n${event.checkOutput}`;

    // 1. 通知该 session 的所有在线客户端
    gateway.sendToSession(sessionId, {
      type: "scheduled_run_start",
      sessionId,
      source,
      name,
    });

    // 2. 通过 SessionRouter 排队执行（复用 per-session 串行机制）
    sessionIdStorage.run(sessionId, () => {
      sessionRouter
        .handleChat(sessionId, prompt, (agentEvent) => {
        // 给所有 scheduled run 的流式事件打标记，让客户端区分来源
        const tagged: typeof agentEvent =
          agentEvent.type === "text_delta" ||
          agentEvent.type === "tool_call" ||
          agentEvent.type === "tool_result" ||
          agentEvent.type === "done" ||
          agentEvent.type === "error"
            ? { ...agentEvent, source: "scheduled" as const }
            : agentEvent;
        // 将 Agent 响应广播给该 session 的所有在线客户端
        // sendToSession 返回 0 表示没有在线客户端，但 Agent 仍然执行（后台运行）
        // 结果已由 Conversation 保存到数据库，用户下次连接时可在历史消息中看到
        gateway.sendToSession(sessionId, tagged);
      })
      .catch((err) => {
        console.error(
          `[Scheduler] Agent error for session ${sessionId}:`,
          err instanceof Error ? err.message : String(err),
        );
        gateway.sendToSession(sessionId, {
          type: "error",
          sessionId,
          source: "scheduled",
          message: `Scheduled task error: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    });
  };

  cronScheduler.onTrigger(handleSchedulerTrigger);
  eventWatcher.onTrigger(handleSchedulerTrigger);

  // 启动定时调度
  cronScheduler.start();
  eventWatcher.start();

  // 将 HealthChecker 注入 McpManager，使 MCP server 加入健康监控
  mcpManager.setHealthChecker(gateway.getHealthChecker());

  console.log(`little_claw server running on ws://${host}:${port}`);

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = async () => {
    cleanupPromise ??= (async () => {
      cronScheduler.stop();
      eventWatcher.stop();
      await lovelyOctopus.stop();
      feishuAdapter?.dispose();
      await mcpManager.disconnectAll();
      // 关闭前保存所有活跃 session 的记忆
      await sessionRouter.saveAllMemories();
      sessionRouter.dispose();
      await gateway.stop();
      vectorStore.close();
    })();
    return cleanupPromise;
  };

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  return { gateway, cleanup };
}

// 直接运行时启动 server
if (import.meta.main) {
  startServer();
}
