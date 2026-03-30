import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { HealthChecker, HealthTarget, HealthStatus } from "../gateway/HealthChecker.ts";
import type { McpServerConfig } from "./types.ts";
import { McpClient } from "./McpClient.ts";
import { createToolsFromMcp } from "./McpToolAdapter.ts";

type ServerStatus = "connected" | "disconnected" | "error";

interface ServerEntry {
  config: McpServerConfig;
  client: McpClient;
  status: ServerStatus;
  toolNames: string[]; // 注册到 registry 的工具名
  error?: string;
}

export class McpManager {
  private registry: ToolRegistry;
  private healthChecker: HealthChecker | null = null;
  private servers = new Map<string, ServerEntry>();
  private configPath: string;

  constructor(registry: ToolRegistry, configPath?: string) {
    this.registry = registry;
    this.configPath =
      configPath ?? join(homedir(), ".little_claw", "config.json");
  }

  /** 注入 HealthChecker，为已连接的 server 补注册健康目标 */
  setHealthChecker(checker: HealthChecker): void {
    this.healthChecker = checker;

    // 补注册已连接的 server
    for (const [name, entry] of this.servers) {
      if (entry.status === "connected") {
        checker.registerTarget(this.createHealthTarget(name, entry));
      }
    }
  }

  // ---- 生命周期 ----

  async connectAll(): Promise<void> {
    const configs = await this.loadMcpConfigs();
    if (configs.length === 0) return;

    let successCount = 0;
    let toolCount = 0;
    const failures: string[] = [];

    const results = await Promise.allSettled(
      configs.map((cfg) => this.connectOne(cfg)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const name = configs[i]!.name;
      if (result.status === "fulfilled") {
        successCount++;
        toolCount += result.value;
      } else {
        const msg = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        failures.push(`${name}: ${msg}`);
      }
    }

    // 打印连接摘要
    let summary = `Connected to ${successCount} MCP server${successCount !== 1 ? "s" : ""}, registered ${toolCount} tool${toolCount !== 1 ? "s" : ""}`;
    if (failures.length > 0) {
      summary += ` (${failures.length} server${failures.length !== 1 ? "s" : ""} failed: ${failures.join("; ")})`;
    }
    console.log(`[MCP] ${summary}`);
  }

  async disconnectAll(): Promise<void> {
    for (const [name, entry] of this.servers) {
      await this.teardown(name, entry);
    }
    this.servers.clear();
  }

  // ---- 查询 ----

  getStatus(): Array<{
    name: string;
    status: ServerStatus;
    toolCount: number;
    error?: string;
  }> {
    return [...this.servers.values()].map((e) => {
      // 实时读取 client 连接状态，而非依赖静态 entry.status
      let status: ServerStatus = e.status;
      if (e.status === "connected" && !e.client.isConnected()) {
        status = "disconnected";
      }
      return {
        name: e.config.name,
        status,
        toolCount: e.toolNames.length,
        error: e.error,
      };
    });
  }

  // ---- 重连 ----

  async reconnect(serverName: string): Promise<void> {
    const entry = this.servers.get(serverName);
    if (!entry) {
      throw new Error(`MCP server "${serverName}" not found`);
    }

    // 先拆除旧连接
    await this.teardown(serverName, entry);
    this.servers.delete(serverName);

    // 重新连接
    await this.connectOne(entry.config);
    console.log(`[MCP] Reconnected to "${serverName}"`);
  }

  // ---- 内部方法 ----

  /** 连接单个 server，注册工具和健康目标。返回注册的工具数量 */
  private async connectOne(config: McpServerConfig): Promise<number> {
    const client = new McpClient(config);

    try {
      await client.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.servers.set(config.name, {
        config,
        client,
        status: "error",
        toolNames: [],
        error: msg,
      });
      throw err;
    }

    const tools = await createToolsFromMcp(client, config.name);
    const toolNames: string[] = [];

    for (const tool of tools) {
      this.registry.register(tool);
      toolNames.push(tool.name);
    }

    const entry: ServerEntry = {
      config,
      client,
      status: "connected",
      toolNames,
    };
    this.servers.set(config.name, entry);

    // 注册健康目标
    if (this.healthChecker) {
      this.healthChecker.registerTarget(
        this.createHealthTarget(config.name, entry),
      );
    }

    return tools.length;
  }

  /** 拆除单个 server：注销工具、注销健康目标、断开连接 */
  private async teardown(name: string, entry: ServerEntry): Promise<void> {
    // 注销工具
    for (const toolName of entry.toolNames) {
      this.registry.unregister(toolName);
    }
    entry.toolNames = [];

    // 注销健康目标
    if (this.healthChecker) {
      this.healthChecker.unregisterTarget(`MCP:${name}`);
    }

    // 断开连接
    try {
      await entry.client.disconnect();
    } catch {
      // 忽略断开时的错误
    }
    entry.status = "disconnected";
  }

  /** 从 config.json 读取 mcp_servers */
  private async loadMcpConfigs(): Promise<McpServerConfig[]> {
    const file = Bun.file(this.configPath);
    if (!(await file.exists())) return [];

    try {
      const raw = await file.json();
      const servers = raw?.mcp_servers;
      if (!Array.isArray(servers)) return [];
      return servers as McpServerConfig[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[MCP] Failed to read config: ${msg}`);
      return [];
    }
  }

  /** 创建一个 HealthTarget，检测子进程存活，意外退出时尝试自动重连一次 */
  private createHealthTarget(
    serverName: string,
    entry: ServerEntry,
  ): HealthTarget {
    return {
      name: `MCP:${serverName}`,

      async check(): Promise<HealthStatus> {
        const now = new Date().toISOString();

        if (entry.client.isConnected()) {
          return { status: "healthy", lastCheckedAt: now };
        }
        return {
          status: "down",
          message: `MCP server "${serverName}" is not connected`,
          lastCheckedAt: now,
        };
      },

      recover: async (): Promise<boolean> => {
        try {
          await this.reconnect(serverName);
          return true;
        } catch {
          return false;
        }
      },
    };
  }
}
