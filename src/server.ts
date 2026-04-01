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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/** 用 AsyncLocalStorage 传递当前 sessionId，避免跨 session 并发时共享变量竞态 */
const sessionIdStorage = new AsyncLocalStorage<string>();

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
  const skillManager = new SkillManager(skillLoader, skillConfig);
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

  const sessionRouter = new SessionRouter({
    db,
    llmProvider,
    toolRegistry,
    skillManager,
    shellTool: builtinTools.shellTool,
    spawnAgentTool,
  });

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
    getActiveSessionCount: () => sessionRouter.getActiveSessionCount(),
  });

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

  const cleanup = async () => {
    cronScheduler.stop();
    eventWatcher.stop();
    await mcpManager.disconnectAll();
    sessionRouter.dispose();
    gateway.stop();
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
