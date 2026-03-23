import { loadConfig } from "./config/index.ts";
import { QianfanClient } from "./llm/QianfanClient.ts";
import { ToolRegistry } from "./tools/ToolRegistry.ts";
import { createBuiltinTools } from "./tools/builtin/index.ts";
import { Repl } from "./core/Repl.ts";
import { Database } from "./db/Database.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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

const dataDir = join(import.meta.dir, "..", "data");
mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, "little_claw.db"));
const repl = new Repl(db, client, toolRegistry);

await repl.start();
