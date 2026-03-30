// ============================================================
// ClientConnectionHealthTarget — 单条客户端连接的心跳检测
// 发送 WebSocket ping frame，等待 pong 回应
// 连续 3 次无响应则主动关闭连接并清理
// ============================================================

import type { ServerWebSocket } from "bun";
import type { HealthTarget, HealthStatus } from "../HealthChecker.ts";

export interface ClientConnectionHealthOptions {
  /** 对应的 WebSocket 连接 */
  ws: ServerWebSocket<{ connectionId: string }>;
  /** 连接 ID */
  connectionId: string;
  /** 等待 pong 的超时时间（ms），默认 3 秒 */
  pongTimeout?: number;
  /** 连接关闭时的清理回调 */
  onClose?: (connectionId: string) => void;
}

/** 连续 ping 无响应次数达到此阈值后触发 recover（关闭连接） */
const MAX_MISSED_PONGS = 3;

export class ClientConnectionHealthTarget implements HealthTarget {
  readonly name: string;

  private ws: ServerWebSocket<{ connectionId: string }>;
  private connectionId: string;
  private pongTimeout: number;
  private onClose?: (connectionId: string) => void;

  private missedPongs = 0;
  private waitingForPong = false;
  private pongReceived = false;

  constructor(options: ClientConnectionHealthOptions) {
    this.ws = options.ws;
    this.connectionId = options.connectionId;
    this.pongTimeout = options.pongTimeout ?? 3_000;
    this.onClose = options.onClose;
    this.name = `WebSocket:${this.connectionId}`;
  }

  /** 外部调用：当收到 pong 时通知此 target */
  handlePong(): void {
    if (this.waitingForPong) {
      this.pongReceived = true;
    }
  }

  async check(): Promise<HealthStatus> {
    const start = Date.now();
    const lastCheckedAt = new Date(start).toISOString();

    try {
      // 发送 ping frame
      this.waitingForPong = true;
      this.pongReceived = false;
      this.ws.ping();

      // 等待 pong 回应
      const gotPong = await this.waitForPong();
      const latencyMs = Date.now() - start;

      this.waitingForPong = false;

      if (gotPong) {
        this.missedPongs = 0;
        return {
          status: "healthy",
          latencyMs,
          lastCheckedAt,
        };
      }

      // pong 超时
      this.missedPongs++;
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        return {
          status: "down",
          latencyMs,
          message: `No pong response for ${this.missedPongs} consecutive checks`,
          lastCheckedAt,
        };
      }

      return {
        status: "degraded",
        latencyMs,
        message: `Pong timeout (${this.missedPongs}/${MAX_MISSED_PONGS} missed)`,
        lastCheckedAt,
      };
    } catch (err) {
      this.waitingForPong = false;
      return {
        status: "down",
        latencyMs: Date.now() - start,
        message: err instanceof Error ? err.message : String(err),
        lastCheckedAt,
      };
    }
  }

  /** 连续 3 次无响应时自动恢复：关闭连接并清理 */
  async recover(): Promise<boolean> {
    try {
      this.ws.close(1001, "health check failed: no pong response");
    } catch {
      // 连接可能已经断开
    }
    this.onClose?.(this.connectionId);
    // recover 返回 false：连接已关闭，不需要重新检查
    return false;
  }

  // ---- 内部方法 ----

  private waitForPong(): Promise<boolean> {
    return new Promise((resolve) => {
      const interval = 50; // 轮询间隔
      let elapsed = 0;

      const timer = setInterval(() => {
        if (this.pongReceived) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        elapsed += interval;
        if (elapsed >= this.pongTimeout) {
          clearInterval(timer);
          resolve(false);
        }
      }, interval);
    });
  }
}
