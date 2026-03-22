import { loadConfig } from "./config/index.ts";
import { QianfanClient } from "./llm/QianfanClient.ts";
import { Conversation } from "./core/Conversation.ts";
import { ToolRegistry } from "./tools/ToolRegistry.ts";
import { createBuiltinTools } from "./tools/builtin/index.ts";
import { AgentLoop } from "./core/AgentLoop.ts";
import { Repl } from "./core/Repl.ts";

const config = loadConfig();
const client = new QianfanClient(
  config.qianfanApiKey,
  config.qianfanBaseModel,
  config.qianfanBaseUrl || undefined,
);

const toolRegistry = new ToolRegistry();
for (const tool of createBuiltinTools()) {
  toolRegistry.register(tool);
}

const conversation = new Conversation();
const agent = new AgentLoop(client, toolRegistry, conversation);
const repl = new Repl(agent, client, conversation, toolRegistry);

await repl.start();
