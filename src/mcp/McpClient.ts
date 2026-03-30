import type {
  McpServerConfig,
  McpToolInfo,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  InitializeResult,
  ToolsListResult,
  ToolsCallResult,
} from "./types.ts";

const DEFAULT_TIMEOUT = 30_000;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class McpClient {
  private config: McpServerConfig;
  private proc: import("bun").Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private connected = false;
  private stderrLogs: string[] = [];

  serverInfo: { name: string; version: string } | null = null;
  capabilities: Record<string, unknown> = {};

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  // ---- 生命周期 ----

  async connect(): Promise<void> {
    const { command, args = [], env } = this.config;

    try {
      this.proc = Bun.spawn([command, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
      });
    } catch (err) {
      throw new Error(
        `Failed to start MCP server "${this.config.name}": ${err instanceof Error ? err.message : err}`
      );
    }

    this.connected = true;

    // 后台读取 stderr，收集日志
    this.readStderr();

    // 后台读取 stdout，分发 JSON-RPC 响应
    this.readStdout();

    // 监听子进程退出
    this.proc.exited.then((code) => {
      this.connected = false;
      // reject 所有还在等待的请求
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(
          new Error(
            `MCP server "${this.config.name}" exited unexpectedly (code ${code})`
          )
        );
        this.pending.delete(id);
      }
    });

    // 握手：发送 initialize 请求
    const result = (await this.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "little_claw", version: "1.0.0" },
      capabilities: {},
    })) as InitializeResult;

    this.serverInfo = result.serverInfo;
    this.capabilities = result.capabilities ?? {};

    // 握手确认：发送 initialized 通知
    this.notify("notifications/initialized");
  }

  async disconnect(): Promise<void> {
    if (!this.proc) return;

    // 清理所有等待中的请求
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP client disconnecting`));
    }
    this.pending.clear();

    try {
      this.proc.stdin.end();
    } catch {
      // stdin 可能已经关闭
    }

    this.proc.kill();
    await this.proc.exited;

    this.connected = false;
    this.proc = null;
  }

  // ---- JSON-RPC 通信 ----

  request(
    method: string,
    params?: Record<string, unknown>,
    timeout = DEFAULT_TIMEOUT
  ): Promise<unknown> {
    if (!this.connected || !this.proc) {
      return Promise.reject(
        new Error(
          `MCP server "${this.config.name}" is not connected`
        )
      );
    }

    const id = this.nextId++;
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined && { params }),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request "${method}" timed out after ${timeout}ms (server: ${this.config.name})`
          )
        );
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage(req);
    });
  }

  // ---- 业务方法 ----

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request("tools/list")) as ToolsListResult;
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as ToolsCallResult;

    return result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
  }

  // ---- 内部方法 ----

  private notify(method: string, params?: Record<string, unknown>): void {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined && { params }),
    };
    this.writeMessage(notification);
  }

  private writeMessage(msg: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.proc) return;
    const line = JSON.stringify(msg) + "\n";
    this.proc.stdin.write(line);
  }

  private async readStdout(): Promise<void> {
    if (!this.proc) return;

    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 按换行符切分，每行一个 JSON-RPC 消息
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          this.handleLine(line);
        }
      }
    } catch {
      // 流关闭时会抛异常，忽略
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line);
    } catch {
      this.stderrLogs.push(`[parse error] ${line}`);
      return;
    }

    // 只处理带 id 的 response，忽略 server 发来的 notification
    if (msg.id == null) return;

    const pending = this.pending.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);

    if (msg.error) {
      pending.reject(
        new Error(
          `MCP error ${msg.error.code}: ${msg.error.message}`
        )
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private async readStderr(): Promise<void> {
    if (!this.proc) return;

    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.stderrLogs.push(text);
      }
    } catch {
      // 流关闭
    }
  }

  /** 获取收集到的 stderr 日志 */
  getStderrLogs(): string[] {
    return this.stderrLogs;
  }

  /** 当前是否已连接 */
  isConnected(): boolean {
    return this.connected;
  }

  /** 服务器名称 */
  get name(): string {
    return this.config.name;
  }
}
