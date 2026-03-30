// ============================================================
// LLMHealthTarget — LLM API 连通性健康检查
// 向 LLM Provider 发送最小请求来验证服务可用性
// ============================================================

import type { LLMProvider } from "../../llm/types.ts";
import type { HealthTarget, HealthStatus } from "../HealthChecker.ts";

export class LLMHealthTarget implements HealthTarget {
  readonly name = "LLM API";

  private provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async check(): Promise<HealthStatus> {
    const start = Date.now();

    try {
      // 发送最小请求：一条 user message，max_tokens=1
      const stream = this.provider.chat(
        [{ role: "user", content: "ping" }],
        { system: undefined, tools: undefined },
      );

      // 消费流直到结束，确认 API 可用
      for await (const _event of stream) {
        // 只要能收到任何事件就说明 API 在响应，不需要全部消费
        break;
      }

      return {
        status: "healthy",
        latencyMs: Date.now() - start,
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      // 401/403 表示认证问题：网络通但 key 有问题，标记为 degraded
      if (this.isAuthError(err)) {
        return {
          status: "degraded",
          latencyMs,
          message: `Authentication error: ${message}`,
          lastCheckedAt: new Date().toISOString(),
        };
      }

      return {
        status: "down",
        latencyMs,
        message,
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }

  // LLM API 挂了我们修不了，不提供 recover

  // ---- 内部方法 ----

  private isAuthError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    // 检查常见 HTTP 状态码标识
    return (
      msg.includes("401") ||
      msg.includes("403") ||
      msg.includes("unauthorized") ||
      msg.includes("forbidden")
    );
  }
}
