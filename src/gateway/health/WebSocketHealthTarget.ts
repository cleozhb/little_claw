// ============================================================
// WebSocketHealthTarget — WebSocket Server 整体健康检查
// 验证 server 仍在监听、连接数在合理范围、近期异常断开未激增
// ============================================================

import type { HealthTarget, HealthStatus } from "../HealthChecker.ts";

export interface WebSocketHealthOptions {
  /** 获取当前连接数 */
  getConnectionCount: () => number;
  /** 连接数上限，超过视为 degraded */
  maxConnections?: number;
  /** 获取 server 是否仍在运行 */
  isServerRunning: () => boolean;
  /** 最近 1 分钟内异常断开数超过此阈值视为 degraded */
  abnormalDisconnectThreshold?: number;
}

export class WebSocketHealthTarget implements HealthTarget {
  readonly name = "WebSocket Server";

  private getConnectionCount: () => number;
  private maxConnections: number;
  private isServerRunning: () => boolean;
  private abnormalDisconnectThreshold: number;

  // 记录异常断开的时间戳，用于统计最近 1 分钟的频率
  private disconnectTimestamps: number[] = [];

  constructor(options: WebSocketHealthOptions) {
    this.getConnectionCount = options.getConnectionCount;
    this.maxConnections = options.maxConnections ?? 1000;
    this.isServerRunning = options.isServerRunning;
    this.abnormalDisconnectThreshold = options.abnormalDisconnectThreshold ?? 10;
  }

  /** 外部调用：记录一次异常断开事件 */
  recordAbnormalDisconnect(): void {
    this.disconnectTimestamps.push(Date.now());
  }

  async check(): Promise<HealthStatus> {
    const now = Date.now();
    const lastCheckedAt = new Date(now).toISOString();

    // 1. Server 是否在运行
    if (!this.isServerRunning()) {
      return {
        status: "down",
        message: "WebSocket server is not running",
        lastCheckedAt,
      };
    }

    // 2. 连接数检查
    const connCount = this.getConnectionCount();
    if (connCount >= this.maxConnections) {
      return {
        status: "degraded",
        message: `Connection count (${connCount}) reached limit (${this.maxConnections})`,
        lastCheckedAt,
      };
    }

    // 3. 最近 1 分钟内异常断开次数
    const oneMinuteAgo = now - 60_000;
    // 清理过期的记录
    this.disconnectTimestamps = this.disconnectTimestamps.filter(
      (ts) => ts > oneMinuteAgo,
    );

    if (this.disconnectTimestamps.length >= this.abnormalDisconnectThreshold) {
      return {
        status: "degraded",
        message: `${this.disconnectTimestamps.length} abnormal disconnects in the last minute`,
        lastCheckedAt,
      };
    }

    return {
      status: "healthy",
      message: `${connCount} active connections`,
      lastCheckedAt,
    };
  }

  // WebSocket server 本身挂了需要进程级重启，不提供 recover
}
