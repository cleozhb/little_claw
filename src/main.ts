/**
 * src/main.ts — 便捷模式：同时启动 Server 和 CLI（开发时用）
 *
 * 先启动 Server（不阻塞），再启动 CLI 连接到本地 Server。
 * 用法: bun run src/main.ts
 */

import { startServer } from "./server.ts";
import { startCli } from "./cli/Client.ts";

// 1. 启动 Server（含 Skill 加载，需要 await）
const { cleanup } = await startServer();

// 给 server 一点时间完成启动
await Bun.sleep(100);

// 2. 启动 CLI 连接到本地 Server
try {
  await startCli();
} finally {
  cleanup();
}
