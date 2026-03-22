import { loadConfig } from "./config/index.ts";
import { QianfanClient } from "./llm/QianfanClient.ts";
import { Conversation } from "./core/Conversation.ts";
import { Repl } from "./core/Repl.ts";

const config = loadConfig();
const client = new QianfanClient(
  config.qianfanApiKey,
  config.qianfanBaseModel,
  config.qianfanBaseUrl || undefined,
);
const conversation = new Conversation();
const repl = new Repl(client, conversation);

await repl.start();
