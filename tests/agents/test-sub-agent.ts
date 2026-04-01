/**
 * test-sub-agent.ts — 手动测试 CODER_AGENT 的 AgentLoop
 *
 * 用法: bun tests/agents/test-sub-agent.ts
 *
 * 使用 .env 中的 LLM_PROVIDER / LLM_API_KEY / LLM_MODEL / LLM_BASE_URL 配置。
 */

import { loadConfig } from "../../src/config/index.ts";
import { createProvider } from "../../src/llm/index.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import { createBuiltinTools } from "../../src/tools/builtin/index.ts";
import { EphemeralConversation } from "../../src/core/EphemeralConversation.ts";
import { AgentLoop } from "../../src/core/AgentLoop.ts";
import { CODER_AGENT } from "../../src/agents/presets.ts";

async function main() {
  const config = loadConfig();
  if (!config.llmApiKey) {
    console.error("Error: LLM_API_KEY is not set in .env");
    process.exit(1);
  }

  console.log(`Provider: ${config.llmProvider}, Model: ${config.llmModel}`);

  const llmProvider = createProvider({
    provider: config.llmProvider,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    baseURL: config.llmBaseUrl,
  });

  // 只注册 read_file, write_file, shell 三个工具
  const workspaceRoot = process.cwd();
  const builtinTools = createBuiltinTools(workspaceRoot);
  const toolRegistry = new ToolRegistry();
  for (const tool of builtinTools.all) {
    toolRegistry.register(tool);
  }

  const conversation = new EphemeralConversation(CODER_AGENT.systemPrompt);

  const agentLoop = new AgentLoop(llmProvider, toolRegistry, conversation, {
    config: CODER_AGENT,
  });

  const userMessage =
    "Create a file fib.py that contains a function to calculate fibonacci numbers, then run it with python3 to verify it works";

  console.log(`\n--- User Message ---\n${userMessage}\n`);
  console.log("--- Agent Events ---\n");

  for await (const event of agentLoop.run(userMessage)) {
    switch (event.type) {
      case "text_delta":
        process.stdout.write(event.text);
        break;
      case "tool_call":
        console.log(`\n[TOOL_CALL] ${event.name}(${JSON.stringify(event.params)})`);
        break;
      case "tool_result":
        console.log(
          `[TOOL_RESULT] ${event.name} → ${event.result.success ? "OK" : "ERROR"}: ${event.result.output.slice(0, 500)}`,
        );
        break;
      case "done":
        console.log(
          `\n[DONE] tokens: input=${event.usage.totalInputTokens}, output=${event.usage.totalOutputTokens}`,
        );
        break;
      case "error":
        console.error(`\n[ERROR] ${event.message}`);
        break;
      default:
        console.log(`\n[${event.type}]`, JSON.stringify(event).slice(0, 300));
    }
  }

  console.log("\n--- Finished ---");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
