/**
 * 统一日志工具 — 自动附带时间戳、文件名、行号。
 *
 * 用法:
 *   import { createLogger } from "../utils/logger";
 *   const log = createLogger("AgentLoop");
 *   log.step("Tool Call", { name: "shell", params: { command: "ls" } });
 */

function getTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * 从 Error.stack 中提取调用者的文件名和行号。
 * 跳过 logger.ts 自身的帧，返回第一个外部调用帧。
 */
function getCallerInfo(): string {
  const err = new Error();
  const stack = err.stack;
  if (!stack) return "unknown:0";

  const lines = stack.split("\n");
  // 跳过 "Error" 行和 logger.ts 内部的帧
  for (const line of lines) {
    if (line.includes("logger.ts")) continue;
    if (line.includes("Error")) continue;

    // 匹配常见的 stack trace 格式:
    //   at funcName (/path/to/file.ts:123:45)
    //   at /path/to/file.ts:123:45
    const match = line.match(/(?:at\s+.*?\s+\(|at\s+)(.*?):(\d+):\d+/);
    if (match) {
      const filePath = match[1]!;
      const lineNo = match[2]!;
      // 只保留 src/ 之后的路径
      const srcIdx = filePath.indexOf("src/");
      const shortPath = srcIdx >= 0 ? filePath.slice(srcIdx) : filePath.split("/").slice(-2).join("/");
      return `${shortPath}:${lineNo}`;
    }
  }
  return "unknown:0";
}

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

function formatMessage(
  level: LogLevel,
  module: string,
  title: string,
  caller: string,
  detail?: string,
): string {
  const ts = getTimestamp();
  let msg = `[${ts}] [${level}] [${module}] [${caller}] ${title}`;
  if (detail) {
    // 每行缩进对齐
    msg += "\n" + detail.split("\n").map((l) => `    ${l}`).join("\n");
  }
  return msg;
}

export interface Logger {
  /** 记录执行步骤（关键路径上的操作） */
  step(title: string, data?: Record<string, unknown>): void;
  /** 记录 LLM 调用（prompt + tools） */
  llmCall(description: string, data: { system?: string; messages?: unknown; tools?: unknown }): void;
  /** 记录 LLM 响应 */
  llmResponse(description: string, data: { text?: string; toolCalls?: unknown; stopReason?: string; usage?: unknown }): void;
  /** 记录工具调用 */
  toolCall(toolName: string, params: unknown): void;
  /** 记录工具结果 */
  toolResult(toolName: string, result: { success: boolean; output?: string; error?: string }): void;
  /** 普通信息 */
  info(message: string, detail?: string): void;
  /** 警告 */
  warn(message: string, detail?: string): void;
  /** 错误 */
  error(message: string, detail?: string): void;
  /** 仅在 DEBUG 模式下输出 */
  debug(message: string, detail?: string): void;
}

export function createLogger(module: string): Logger {
  const isDebug = !!process.env.DEBUG;

  return {
    step(title: string, data?: Record<string, unknown>) {
      const caller = getCallerInfo();
      let detail: string | undefined;
      if (data) {
        detail = Object.entries(data)
          .map(([k, v]) => {
            const s = typeof v === "string" ? v : JSON.stringify(v);
            const truncated = s.length > 500 ? s.slice(0, 500) + "... (truncated)" : s;
            return `${k}: ${truncated}`;
          })
          .join("\n");
      }
      console.log(formatMessage("INFO", module, `▶ ${title}`, caller, detail));
    },

    llmCall(description: string, data: { system?: string; messages?: unknown; tools?: unknown }) {
      const caller = getCallerInfo();
      const parts: string[] = [];
      if (data.system) {
        const sys = data.system.length > 1000 ? data.system.slice(0, 1000) + "... (truncated)" : data.system;
        parts.push(`[System Prompt]\n${sys}`);
      }
      if (data.messages) {
        const msgs = JSON.stringify(data.messages);
        const truncated = msgs.length > 2000 ? msgs.slice(0, 2000) + "... (truncated)" : msgs;
        parts.push(`[Messages] ${truncated}`);
      }
      if (data.tools) {
        const toolNames = Array.isArray(data.tools)
          ? (data.tools as Array<{ name: string }>).map((t) => t.name).join(", ")
          : JSON.stringify(data.tools).slice(0, 200);
        parts.push(`[Tools] ${toolNames}`);
      }
      console.log(formatMessage("INFO", module, `🤖 LLM Call: ${description}`, caller, parts.join("\n")));
    },

    llmResponse(description: string, data: { text?: string; toolCalls?: unknown; stopReason?: string; usage?: unknown }) {
      const caller = getCallerInfo();
      const parts: string[] = [];
      if (data.stopReason) {
        parts.push(`stop_reason: ${data.stopReason}`);
      }
      if (data.text !== undefined) {
        const t = data.text.length > 500 ? data.text.slice(0, 500) + "... (truncated)" : data.text;
        parts.push(`text (${data.text.length} chars): "${t}"`);
      }
      if (data.toolCalls) {
        parts.push(`tool_calls: ${JSON.stringify(data.toolCalls).slice(0, 500)}`);
      }
      if (data.usage) {
        parts.push(`usage: ${JSON.stringify(data.usage)}`);
      }
      console.log(formatMessage("INFO", module, `📨 LLM Response: ${description}`, caller, parts.join("\n")));
    },

    toolCall(toolName: string, params: unknown) {
      const caller = getCallerInfo();
      const p = JSON.stringify(params);
      const truncated = p.length > 500 ? p.slice(0, 500) + "... (truncated)" : p;
      console.log(formatMessage("INFO", module, `🔧 Tool Call: ${toolName}`, caller, `params: ${truncated}`));
    },

    toolResult(toolName: string, result: { success: boolean; output?: string; error?: string }) {
      const caller = getCallerInfo();
      const icon = result.success ? "✅" : "❌";
      const body = result.success ? (result.output ?? "") : (result.error ?? "");
      const truncated = body.length > 500 ? body.slice(0, 500) + "... (truncated)" : body;
      console.log(formatMessage("INFO", module, `${icon} Tool Result: ${toolName}`, caller, `success: ${result.success}\noutput: "${truncated}"`));
    },

    info(message: string, detail?: string) {
      const caller = getCallerInfo();
      console.log(formatMessage("INFO", module, message, caller, detail));
    },

    warn(message: string, detail?: string) {
      const caller = getCallerInfo();
      console.warn(formatMessage("WARN", module, message, caller, detail));
    },

    error(message: string, detail?: string) {
      const caller = getCallerInfo();
      console.error(formatMessage("ERROR", module, message, caller, detail));
    },

    debug(message: string, detail?: string) {
      if (!isDebug) return;
      const caller = getCallerInfo();
      console.log(formatMessage("DEBUG", module, message, caller, detail));
    },
  };
}
