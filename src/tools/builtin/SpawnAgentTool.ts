import type { Tool, ToolResult, ToolExecuteOptions } from "../types.ts";
import type { ShellTool } from "../types.ts";
import type { ToolRegistry } from "../ToolRegistry.ts";
import type { LLMProvider } from "../../llm/types.ts";
import type { AgentEvent } from "../../types/message.ts";
import { AgentLoop } from "../../core/AgentLoop.ts";
import { EphemeralConversation } from "../../core/EphemeralConversation.ts";
import { createAgentConfig } from "../../agents/AgentConfig.ts";
import type { ContextRetriever } from "../../memory/ContextRetriever.ts";
import type { MemoryManager } from "../../memory/MemoryManager.ts";
import type { SkillManager } from "../../skills/SkillManager.ts";
import type { AgentRegistry, RegisteredAgent } from "../../team/AgentRegistry.ts";
import { buildTeamAgentSystemPrompt } from "../../team/AgentWorker.ts";
import { ContentStore } from "../../memory/ContentStore.ts";
import { createLogger } from "../../utils/logger.ts";

const log = createLogger("SpawnAgent");

const SUB_AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CONTENT_REF_THRESHOLD = 3000; // chars — store long sub-agent results as content_ref above this
const EMPTY_MODEL_RESPONSE_MESSAGE = "[Model returned an empty response. Please try again.]";

export type SubAgentEventCallback = (event: AgentEvent) => void;

export interface SpawnAgentToolOptions {
  llmProvider: LLMProvider;
  toolRegistry: ToolRegistry;
  getAgentRegistry?: () => AgentRegistry | undefined;
  getSkillManager?: () => SkillManager | undefined;
  shellTool?: ShellTool;
  memoryManager?: MemoryManager;
  contextRetriever?: ContextRetriever;
  contentStore?: ContentStore;
}

export interface SpawnAgentTool extends Tool {
  /** 设置当前 session 的事件回调（每次 AgentLoop.run 前由 SessionRouter 设置） */
  setEventCallback(cb: SubAgentEventCallback | undefined): void;
}

export function createSpawnAgentTool(
  options: SpawnAgentToolOptions,
): SpawnAgentTool {
  const toolOptions = options;
  const { llmProvider, toolRegistry } = toolOptions;

  /** session 级别的事件回调，由外部在每次 run 前设置 */
  let currentCallback: SubAgentEventCallback | undefined;

  return {
    name: "spawn_agent",
    description:
      "Delegate a task to a specialized team agent from the configured AgentRegistry. Use an active agent's name or alias as agent_type. The sub-agent will work independently with that agent's tools, skills, SOUL.md, and AGENTS.md, then return its result.",
    parameters: {
      type: "object",
      properties: {
        agent_type: {
          type: "string",
          description:
            "The name or alias of an active team agent to spawn.",
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

      const agentRegistry = toolOptions.getAgentRegistry?.();
      const agent = resolveSpawnAgent(agentRegistry, agentType);
      if (!agent) {
        const available = listSpawnableAgentNames(agentRegistry);
        return {
          success: false,
          output: "",
          error: available.length > 0
            ? `Unknown or inactive agent "${agentType}". Available agents: ${available.join(", ")}.`
            : `Unknown or inactive agent "${agentType}". No active team agents are configured.`,
        };
      }

      log.step("Spawning sub-agent", {
        agentType,
        resolvedAgent: agent.config.name,
        task,
        context: context ?? "(none)",
      });

      const config = createAgentConfig({
        name: agent.config.name,
        systemPrompt: buildTeamAgentSystemPrompt(agent),
        allowedTools: agent.config.tools,
        approvalRules: agent.config.approval_rules,
        maxTurns: 10,
        canSpawnSubAgent: false,
      });

      config.systemPrompt +=
        "\n\nOnce you have completed the task, stop immediately and provide a brief summary of what you did. Do not perform additional verification, optimization, or cleanup unless explicitly asked. Do not create extra files beyond what is required.";

      const conversation = new EphemeralConversation("Team sub-agent execution.");

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
        {
          config,
          skillManager: toolOptions.getSkillManager?.(),
          configuredSkillNames: agent.config.skills,
          shellTool: toolOptions.shellTool,
          memoryManager: toolOptions.memoryManager,
          contextRetriever: toolOptions.contextRetriever,
          runMode: "agent_dm",
          contextMode: "auto",
        },
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
        agentName: agent.config.name,
        task,
      });

      log.info(`Sub-agent "${agent.config.name}" started`, `task: ${task}\nconfig: ${JSON.stringify({ maxTurns: config.maxTurns, allowedTools: config.allowedTools })}`);

      // 收集 Sub-Agent 的文本输出
      let resultText = "";
      let hitMaxTurns = false;
      let timedOut = false;

      try {
        // 超时保护：5 分钟
        const result = await Promise.race([
          collectAgentResult(subAgentLoop, task, agent.config.name, onEvent),
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
          agentName: agent.config.name,
          result: `Error: ${errMsg}`,
        });
        return {
          success: false,
          output: "",
          error: `Sub-agent "${agent.config.name}" failed: ${errMsg}`,
        };
      }

      if (timedOut) {
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener("abort", abortHandler);
        }
        const partial = resultText || "(no output before timeout)";
        log.warn(`Sub-agent "${agent.config.name}" timed out after ${SUB_AGENT_TIMEOUT_MS / 1000}s`, `partial result length: ${partial.length}`);
        onEvent?.({
          type: "sub_agent_done",
          agentName: agent.config.name,
          result: `[TIMEOUT] ${partial}`,
        });
        return {
          success: true,
          output: `[Sub-agent "${agent.config.name}" timed out after 5 minutes]\n\nPartial result:\n${partial}`,
        };
      }

      const meaningfulResultText = isEmptyModelFallback(resultText) ? "" : resultText;
      let output = hitMaxTurns
        ? `[NOTE: Sub-agent "${agent.config.name}" reached maximum iterations and returned partial results]\n\n${meaningfulResultText}`
        : meaningfulResultText || "(sub-agent produced no text output)";

      // 结果长度控制：超过阈值时转存为 content_ref，父 agent 需要细节时分页读取。
      if (output.length > CONTENT_REF_THRESHOLD) {
        const originalLength = output.length;
        log.info(`Sub-agent "${agent.config.name}" result too long (${originalLength} chars), storing as content_ref...`);
        const digest = await getContentStore(toolOptions, options).storeText({
          sourceTool: "spawn_agent",
          sourceUri: `spawn_agent:${agent.config.name}`,
          title: `Sub-agent result: ${agent.config.name}`,
          content: output,
          mimeType: "text/plain",
          projectContextPath: options?.projectContextPath,
          metadata: {
            agent_name: agent.config.name,
            requested_agent_type: agentType,
            task,
            context: context ?? null,
            hit_max_turns: hitMaxTurns,
            original_output_length: originalLength,
          },
        });
        output = JSON.stringify({
          ...digest,
          note:
            `Sub-agent "${agent.config.name}" returned ${originalLength} chars. ` +
            "The full result was stored as content_ref; use read_content_ref for details.",
        }, null, 2);
      }

      log.step(`Sub-agent "${agent.config.name}" completed`, {
        resultLength: output.length,
        hitMaxTurns,
        result: output,
      });

      if (abortHandler && options?.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      onEvent?.({
        type: "sub_agent_done",
        agentName: agent.config.name,
        result: output,
      });

      return {
        success: true,
        output,
      };
    },
  };
}

function resolveSpawnAgent(agentRegistry: AgentRegistry | undefined, nameOrAlias: string): RegisteredAgent | null {
  if (!agentRegistry) return null;
  const normalized = normalizeAgentToken(nameOrAlias);
  return (
    agentRegistry.listActive().find((agent) => {
      if (normalizeAgentToken(agent.config.name) === normalized) return true;
      return agent.config.aliases.some((alias) => normalizeAgentToken(alias) === normalized);
    }) ?? null
  );
}

function listSpawnableAgentNames(agentRegistry: AgentRegistry | undefined): string[] {
  return agentRegistry?.listActive().map((agent) => agent.config.name) ?? [];
}

function normalizeAgentToken(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function isEmptyModelFallback(text: string): boolean {
  return text.trim() === EMPTY_MODEL_RESPONSE_MESSAGE;
}

function getContentStore(
  toolOptions: SpawnAgentToolOptions,
  executeOptions?: ToolExecuteOptions,
): ContentStore {
  if (executeOptions?.contentStoreBaseDir) {
    return new ContentStore(executeOptions.contentStoreBaseDir);
  }
  return toolOptions.contentStore ?? new ContentStore(toolOptions.memoryManager?.getFileMemory()?.getBaseDir());
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
