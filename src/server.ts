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
import { Database } from "./db/Database.ts";
import { SessionRouter } from "./gateway/SessionRouter.ts";
import { GatewayServer } from "./gateway/GatewayServer.ts";
import { SkillManager } from "./skills/SkillManager.ts";
import { SkillLoader } from "./skills/SkillLoader.ts";
import { SkillConfigFile } from "./skills/SkillConfigFile.ts";
import { McpManager } from "./mcp/McpManager.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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

  const toolRegistry = new ToolRegistry();
  const workspaceRoot = join(process.cwd(), "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const builtinTools = createBuiltinTools(workspaceRoot);
  for (const tool of builtinTools.all) {
    toolRegistry.register(tool);
  }

  const dataDir = join(import.meta.dir, "..", "data");
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "little_claw.db"));

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
  });

  const gateway = new GatewayServer({
    port,
    hostname: host,
    db,
    toolRegistry,
    llmProvider,
    skillManager,
    mcpManager,
    onChat: (connectionId, sessionId, content) => {
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
    },
    getActiveSessionCount: () => sessionRouter.getActiveSessionCount(),
  });

  gateway.start();

  // 将 HealthChecker 注入 McpManager，使 MCP server 加入健康监控
  mcpManager.setHealthChecker(gateway.getHealthChecker());

  console.log(`little_claw server running on ws://${host}:${port}`);

  const cleanup = async () => {
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
