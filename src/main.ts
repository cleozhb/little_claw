import { loadConfig } from "./config/index.ts";
import { createProvider } from "./llm/index.ts";
import { ToolRegistry } from "./tools/ToolRegistry.ts";
import { createBuiltinTools } from "./tools/builtin/index.ts";
import { Repl } from "./core/Repl.ts";
import { Database } from "./db/Database.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const config = loadConfig();

if (!config.llmApiKey) {
  console.error("Error: LLM_API_KEY is not set in .env");
  process.exit(1);
}

console.log(`Provider: ${config.llmProvider}, Model: ${config.llmModel}, BaseURL: ${config.llmBaseUrl ?? "(default)"}`);

const client = createProvider({
  provider: config.llmProvider,
  apiKey: config.llmApiKey,
  model: config.llmModel,
  baseURL: config.llmBaseUrl,
});

const toolRegistry = new ToolRegistry();
for (const tool of createBuiltinTools()) {
  toolRegistry.register(tool);
}

const dataDir = join(import.meta.dir, "..", "data");
mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, "little_claw.db"));
const repl = new Repl(db, client, toolRegistry);

await repl.start();
