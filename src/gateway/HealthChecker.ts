// ============================================================
// HealthChecker — 系统健康监控
// 定时对注册的监控目标执行健康检查，支持自动恢复和状态变化通知
// ============================================================

// ---- Types ----

export interface HealthStatus {
  status: "healthy" | "degraded" | "down";
  latencyMs?: number;
  message?: string;
  lastCheckedAt: string; // ISO 时间
}

export interface HealthTarget {
  name: string; // 如 "LLM API"、"WebSocket:conn_123"
  check(): Promise<HealthStatus>;
  recover?(): Promise<boolean>;
}

interface HealthCheckerOptions {
  checkInterval?: number; // 定时检查间隔，默认 30 秒
  timeout?: number;       // 单次检查超时，默认 5 秒
}

type StatusChangeCallback = (
  name: string,
  oldStatus: HealthStatus,
  newStatus: HealthStatus,
) => void;

// ---- HealthChecker ----

export class HealthChecker {
  private readonly checkInterval: number;
  private readonly timeout: number;

  private targets = new Map<string, HealthTarget>();
  private statusCache = new Map<string, HealthStatus>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private callbacks: StatusChangeCallback[] = [];

  constructor(options: HealthCheckerOptions = {}) {
    this.checkInterval = options.checkInterval ?? 30_000;
    this.timeout = options.timeout ?? 5_000;
  }

  // ---- 注册 / 注销 ----

  registerTarget(target: HealthTarget): void {
    this.targets.set(target.name, target);
  }

  unregisterTarget(name: string): void {
    this.targets.delete(name);
    this.statusCache.delete(name);
  }

  // ---- 启动 / 停止 ----

  start(): void {
    if (this.timer) return;
    // 启动后立即检查一次
    this.checkAll();
    this.timer = setInterval(() => this.checkAll(), this.checkInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---- 查询 ----

  /** 返回最近一次的检查结果缓存 */
  getStatus(): Map<string, HealthStatus> {
    return new Map(this.statusCache);
  }

  // ---- 全量检查 ----

  /** 立即对所有 target 并行执行一次检查 */
  async checkAll(): Promise<Map<string, HealthStatus>> {
    const entries = Array.from(this.targets.entries());

    const results = await Promise.allSettled(
      entries.map(([name, target]) => this.checkOne(name, target)),
    );

    // 某个 target 的 checkOne 抛出未预期异常时，将其标记为 down
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "rejected") {
        const [name] = entries[i]!;
        const errMsg = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        const oldStatus = this.statusCache.get(name);
        const newStatus: HealthStatus = {
          status: "down",
          message: `Unexpected check error: ${errMsg}`,
          lastCheckedAt: new Date().toISOString(),
        };
        this.updateStatus(name, oldStatus, newStatus);
      }
    }

    return this.getStatus();
  }

  // ---- 事件回调 ----

  onStatusChange(callback: StatusChangeCallback): void {
    this.callbacks.push(callback);
  }

  // ---- 内部方法 ----

  /** 对单个 target 执行一次检查，处理超时、自动恢复和状态变化通知 */
  private async checkOne(name: string, target: HealthTarget): Promise<void> {
    const newStatus = await this.executeCheck(target);
    const oldStatus = this.statusCache.get(name);

    // 如果从 healthy 变为 down，且有 recover 方法，尝试自动恢复
    if (
      oldStatus?.status === "healthy" &&
      newStatus.status === "down" &&
      target.recover
    ) {
      const recovered = await this.tryRecover(target);
      if (recovered) {
        // 恢复成功，重新检查确认
        const recheckStatus = await this.executeCheck(target);
        this.updateStatus(name, oldStatus, recheckStatus);
        return;
      }
    }

    this.updateStatus(name, oldStatus, newStatus);
  }

  /** 执行单次 check，超时视为 down */
  private async executeCheck(target: HealthTarget): Promise<HealthStatus> {
    const start = Date.now();

    try {
      const result = await Promise.race([
        target.check(),
        this.createTimeout(),
      ]);
      return result;
    } catch (err) {
      return {
        status: "down",
        latencyMs: Date.now() - start,
        message: err instanceof Error ? err.message : String(err),
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }

  /** 创建一个超时 Promise，超时后 resolve 为 down 状态 */
  private createTimeout(): Promise<HealthStatus> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          status: "down",
          message: `Health check timed out after ${this.timeout}ms`,
          lastCheckedAt: new Date().toISOString(),
        });
      }, this.timeout);
    });
  }

  /** 尝试自动恢复，捕获异常返回 false */
  private async tryRecover(target: HealthTarget): Promise<boolean> {
    try {
      return await target.recover!();
    } catch {
      return false;
    }
  }

  /** 更新缓存并在状态变化时触发回调 */
  private updateStatus(
    name: string,
    oldStatus: HealthStatus | undefined,
    newStatus: HealthStatus,
  ): void {
    this.statusCache.set(name, newStatus);

    // 状态变化时通知
    if (oldStatus && oldStatus.status !== newStatus.status) {
      for (const cb of this.callbacks) {
        try {
          cb(name, oldStatus, newStatus);
        } catch {
          // 回调异常不应影响健康检查流程
        }
      }
    }
  }
}
