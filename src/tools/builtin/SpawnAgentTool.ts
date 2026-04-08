import type { Tool, ToolResult, ToolExecuteOptions } from "../types.ts";
import type { ToolRegistry } from "../ToolRegistry.ts";
import type { LLMProvider } from "../../llm/types.ts";
import type { AgentEvent } from "../../types/message.ts";
import { AgentLoop } from "../../core/AgentLoop.ts";
import { EphemeralConversation } from "../../core/EphemeralConversation.ts";
import { getAgentConfig } from "../../agents/presets.ts";
import { createLogger } from "../../utils/logger.ts";

const log = createLogger("SpawnAgent");

const SUB_AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SUMMARY_THRESHOLD = 3000; // chars — trigger summarization above this
const SUMMARY_MAX_CHARS = 1500;

export type SubAgentEventCallback = (event: AgentEvent) => void;

export interface SpawnAgentToolOptions {
  llmProvider: LLMProvider;
  toolRegistry: ToolRegistry;
}

export interface SpawnAgentTool extends Tool {
  /** 设置当前 session 的事件回调（每次 AgentLoop.run 前由 SessionRouter 设置） */
  setEventCallback(cb: SubAgentEventCallback | undefined): void;
}

export function createSpawnAgentTool(
  options: SpawnAgentToolOptions,
): SpawnAgentTool {
  const { llmProvider, toolRegistry } = options;

  /** session 级别的事件回调，由外部在每次 run 前设置 */
  let currentCallback: SubAgentEventCallback | undefined;

  return {
    name: "spawn_agent",
    description:
      "Delegate a task to a specialized sub-agent. Use this when a task requires focused expertise. Available agent types: 'coder' (writes and modifies code), 'planner' (analyzes and creates plans, read-only), 'researcher' (gathers information). The sub-agent will work independently and return its results.",
    parameters: {
      type: "object",
      properties: {
        agent_type: {
          type: "string",
          enum: ["coder", "planner", "researcher"],
          description:
            "The type of specialist agent to spawn.",
        },
        task: {
          type: "string",
          description: "The specific task to delegate to the sub-agent.",
        },
        context: {
          type: "string",
          description:
            "Brief summary of relevant background info for the sub-agent. Keep under 500 words. Only include information directly needed for this specific task — do not pass full conversation history or unrelated details.",
        },
      },
      required: ["agent_type", "task"],
    },

    setEventCallback(cb: SubAgentEventCallback | undefined): void {
      currentCallback = cb;
    },

    async execute(params: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult> {
      const agentType = params.agent_type as string;
      const task = params.task as string;
      const context = params.context as string | undefined;

      if (!agentType || !task) {
        return {
          success: false,
          output: "",
          error: "Both agent_type and task are required.",
        };
      }

      log.step("Spawning sub-agent", {
        agentType,
        task,
        context: context ?? "(none)",
      });

      const config = getAgentConfig(agentType);

      // 在 sub-agent 的 system prompt 末尾追加强引导，防止完成任务后继续做多余的事
      const subAgentPrompt =
        config.systemPrompt +
        "\n\nOnce you have completed the task, stop immediately and provide a brief summary of what you did. Do not perform additional verification, optimization, or cleanup unless explicitly asked. Do not create extra files beyond what is required.";

      const conversation = new EphemeralConversation(subAgentPrompt);

      // 如果有背景信息，作为第一条 user message 注入
      if (context) {
        conversation.addUser(`Background context: ${context}`);
        conversation.addAssistant(
          "Understood. I have the background context. Please provide the task.",
        );
      }

      const subAgentLoop = new AgentLoop(
        llmProvider,
        toolRegistry,
        conversation,
        { config },
      );

      const onEvent = currentCallback;

      // 透传 abort signal：父 agent 被 abort 时，子 agent 也立即中断
      let abortHandler: (() => void) | undefined;
      if (options?.signal) {
        if (options.signal.aborted) {
          subAgentLoop.abort();
        } else {
          abortHandler = () => subAgentLoop.abort();
          options.signal.addEventListener("abort", abortHandler, { once: true });
        }
      }

      // 通知外部：Sub-Agent 开始执行
      onEvent?.({
        type: "sub_agent_start",
        agentName: agentType,
        task,
      });

      log.info(`Sub-agent "${agentType}" started`, `task: ${task}\nconfig: ${JSON.stringify({ maxTurns: config.maxTurns, allowedTools: config.allowedTools })}`);

      // 收集 Sub-Agent 的文本输出
      let resultText = "";
      let hitMaxTurns = false;
      let timedOut = false;

      try {
        // 超时保护：5 分钟
        const result = await Promise.race([
          collectAgentResult(subAgentLoop, task, agentType, onEvent),
          timeout(SUB_AGENT_TIMEOUT_MS).then(() => {
            timedOut = true;
            return null;
          }),
        ]);

        resultText = result?.text ?? "";
        hitMaxTurns = result?.hitMaxTurns ?? false;
      } catch (err) {
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener("abort", abortHandler);
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`Sub-agent "${agentType}" failed`, errMsg);
        onEvent?.({
          type: "sub_agent_done",
          agentName: agentType,
          result: `Error: ${errMsg}`,
        });
        return {
          success: false,
          output: "",
          error: `Sub-agent "${agentType}" failed: ${errMsg}`,
        };
      }

      if (timedOut) {
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener("abort", abortHandler);
        }
        const partial = resultText || "(no output before timeout)";
        log.warn(`Sub-agent "${agentType}" timed out after ${SUB_AGENT_TIMEOUT_MS / 1000}s`, `partial result length: ${partial.length}`);
        onEvent?.({
          type: "sub_agent_done",
          agentName: agentType,
          result: `[TIMEOUT] ${partial}`,
        });
        return {
          success: true,
          output: `[Sub-agent "${agentType}" timed out after 5 minutes]\n\nPartial result:\n${partial}`,
        };
      }

      let output = hitMaxTurns
        ? `[NOTE: Sub-agent "${agentType}" reached maximum iterations and returned partial results]\n\n${resultText}`
        : resultText || "(sub-agent produced no text output)";

      // 结果长度控制：超过阈值时做摘要压缩
      if (output.length > SUMMARY_THRESHOLD) {
        const originalLength = output.length;
        log.info(`Sub-agent "${agentType}" result too long (${originalLength} chars), summarizing...`);
        const summarized = await summarizeResult(llmProvider, output);
        output = `[Sub-agent returned ${originalLength} chars, summarized below]\n\n${summarized}`;
      }

      log.step(`Sub-agent "${agentType}" completed`, {
        resultLength: output.length,
        hitMaxTurns,
        result: output,
      });

      if (abortHandler && options?.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      onEvent?.({
        type: "sub_agent_done",
        agentName: agentType,
        result: output,
      });

      return {
        success: true,
        output,
      };
    },
  };
}

/**
 * 调用 LLM 对过长的 Sub-Agent 结果做摘要压缩。
 * 失败时 fallback 为首尾截断。
 */
async function summarizeResult(
  llmProvider: LLMProvider,
  result: string,
): Promise<string> {
  try {
    const prompt = `Summarize the following sub-agent output into a concise result, preserving all key decisions, action items, and technical details. Keep under ${SUMMARY_MAX_CHARS} characters.\n\nOriginal output:\n${result}`;

    let summary = "";
    for await (const event of llmProvider.chat(
      [{ role: "user", content: prompt }],
      { system: "You are a concise summarizer. Output only the summary, nothing else." },
    )) {
      if (event.type === "text_delta") {
        summary += event.text;
      }
    }

    if (summary.length > 0) {
      return summary;
    }
  } catch (err) {
    console.error(
      `[WARN] Failed to summarize sub-agent result: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // fallback：保留前 1000 + 后 1000 字符
  return (
    result.slice(0, 1000) +
    "\n\n[... truncated ...]\n\n" +
    result.slice(-1000)
  );
}

/**
 * 消费 Sub-Agent 的事件流，收集文本输出并冒泡事件。
 */
async function collectAgentResult(
  agentLoop: AgentLoop,
  task: string,
  agentName: string,
  onEvent?: SubAgentEventCallback,
): Promise<{ text: string; hitMaxTurns: boolean }> {
  let text = "";
  let hitMaxTurns = false;
  let turnCount = 0;

  for await (const event of agentLoop.run(task)) {
    // 冒泡所有中间事件
    onEvent?.({
      type: "sub_agent_progress",
      agentName,
      event,
    });

    // 详细记录 sub-agent 的每个中间事件
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "tool_call":
        log.toolCall(`[sub:${agentName}] ${event.name}`, event.params);
        break;
      case "tool_result":
        log.toolResult(`[sub:${agentName}] ${event.name}`, {
          success: event.result.success,
          output: event.result.output,
          error: event.result.error,
        });
        break;
      case "done":
        turnCount++;
        log.info(`[sub:${agentName}] Turn ${turnCount} done`, `accumulated text: ${text.length} chars`);
        break;
      case "error":
        if (event.message.includes("exceeded maximum iterations")) {
          hitMaxTurns = true;
        }
        log.warn(`[sub:${agentName}] Error event`, event.message);
        break;
    }
  }

  log.step(`Sub-agent "${agentName}" finished`, {
    totalTurns: turnCount,
    resultLength: text.length,
    hitMaxTurns,
  });

  return { text, hitMaxTurns };
}

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
