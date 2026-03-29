/**
 * src/server.ts — Gateway Server 入口
 *
 * 启动 Database、ToolRegistry、SessionRouter、GatewayServer。
 * 用法: bun run src/server.ts
 */

import { loadConfig } from "./config/index.ts";
import { createProvider } from "./llm/index.ts";
import { ToolRegistry } from "./tools/ToolRegistry.ts";
import { createBuiltinTools } from "./tools/builtin/index.ts";
import { Database } from "./db/Database.ts";
import { SessionRouter } from "./gateway/SessionRouter.ts";
import { GatewayServer } from "./gateway/GatewayServer.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function startServer(): { gateway: GatewayServer; cleanup: () => void } {
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
  for (const tool of createBuiltinTools(workspaceRoot)) {
    toolRegistry.register(tool);
  }

  const dataDir = join(import.meta.dir, "..", "data");
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "little_claw.db"));

  const sessionRouter = new SessionRouter({ db, llmProvider, toolRegistry });

  const gateway = new GatewayServer({
    port,
    hostname: host,
    db,
    toolRegistry,
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

  console.log(`my-agent server running on ws://${host}:${port}`);

  const cleanup = () => {
    sessionRouter.dispose();
    gateway.stop();
  };

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  return { gateway, cleanup };
}

// 直接运行时启动 server
if (import.meta.main) {
  startServer();
}
