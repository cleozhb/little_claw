import * as readline from "node:readline/promises";
import type { AgentLoop } from "./AgentLoop.ts";
import type { Conversation } from "./Conversation.ts";
import type { QianfanClient } from "../llm/QianfanClient.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";

// ANSI colors
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

const MAX_RESULT_PREVIEW = 200;

const COMMANDS = ["/help", "/clear", "/model ", "/tools", "/quit", "/exit"];

export class Repl {
  private agent: AgentLoop;
  private client: QianfanClient;
  private conversation: Conversation;
  private toolRegistry: ToolRegistry;

  constructor(
    agent: AgentLoop,
    client: QianfanClient,
    conversation: Conversation,
    toolRegistry: ToolRegistry,
  ) {
    this.agent = agent;
    this.client = client;
    this.conversation = conversation;
    this.toolRegistry = toolRegistry;
  }

  private get help(): string {
    return `Available commands:
  /help          Show this help message
  /clear         Clear conversation history
  /model <name>  Switch model (e.g. /model ernie-4.5-8k)
  /tools         List registered tools
  /quit          Exit the chat
  /exit          Exit the chat

Multi-line input:
  Type ${CYAN}"""${RESET} to start, type ${CYAN}"""${RESET} again to send.
`;
  }

  private printWelcome(): void {
    const tools = this.toolRegistry.getAll();
    const toolNames = tools.map((t) => t.name).join(", ");
    console.log(`
${CYAN}Welcome to Little Claw!${RESET}
Model: ${YELLOW}${this.client.getModel()}${RESET}
Tools: ${DIM}${toolNames}${RESET}
Type your message and press Enter to chat.
Type ${CYAN}/help${RESET} for available commands.
`);
  }

  private printTools(): void {
    const tools = this.toolRegistry.getAll();
    if (tools.length === 0) {
      console.log("No tools registered.\n");
      return;
    }
    console.log("Registered tools:");
    for (const tool of tools) {
      console.log(`  ${YELLOW}${tool.name}${RESET} - ${DIM}${tool.description}${RESET}`);
    }
    console.log();
  }

  private formatParams(params: Record<string, unknown>): string {
    const entries = Object.entries(params);
    if (entries.length === 0) return "{}";
    const parts = entries.map(([k, v]) => {
      const val = typeof v === "string"
        ? v.length > 60 ? `"${v.slice(0, 57)}..."` : `"${v}"`
        : JSON.stringify(v);
      return `${k}: ${val}`;
    });
    return `{ ${parts.join(", ")} }`;
  }

  private truncate(text: string): string {
    if (text.length <= MAX_RESULT_PREVIEW) return text;
    return text.slice(0, MAX_RESULT_PREVIEW) + "...";
  }

  private async readMultiline(rl: readline.Interface): Promise<string> {
    const lines: string[] = [];
    console.log(`${DIM}(multi-line mode, type """ to end)${RESET}`);
    while (true) {
      let line: string;
      try {
        line = await rl.question("... ");
      } catch {
        break;
      }
      if (line.trim() === '"""') break;
      lines.push(line);
    }
    return lines.join("\n");
  }

  async start(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line: string): [string[], string] => {
        if (line.startsWith("/")) {
          const hits = COMMANDS.filter((c) => c.startsWith(line));
          return [hits.length ? hits : COMMANDS, line];
        }
        return [[], line];
      },
    });

    this.printWelcome();

    let closed = false;
    rl.on("close", () => {
      closed = true;
    });

    const handleSigint = () => {
      console.log(`\n${RESET}Bye!`);
      rl.close();
      process.exit(0);
    };
    process.on("SIGINT", handleSigint);

    try {
      while (!closed) {
        let input: string;
        try {
          input = await rl.question("> ");
        } catch {
          break;
        }
        if (closed) break;

        const trimmed = input.trim();
        if (!trimmed) continue;

        // Multi-line mode
        if (trimmed === '"""') {
          input = await this.readMultiline(rl);
          if (!input.trim()) continue;
        } else {
          input = trimmed;
        }

        // Commands
        if (input === "/quit" || input === "/exit") {
          console.log("Bye!");
          break;
        }

        if (input === "/clear") {
          this.conversation.clear();
          console.log("Conversation cleared.\n");
          continue;
        }

        if (input === "/help") {
          console.log(this.help);
          continue;
        }

        if (input === "/tools") {
          this.printTools();
          continue;
        }

        if (input.startsWith("/model")) {
          const newModel = input.slice(6).trim();
          if (!newModel) {
            console.log(`Current model: ${YELLOW}${this.client.getModel()}${RESET}`);
          } else {
            this.client.setModel(newModel);
            console.log(`Model switched to: ${YELLOW}${newModel}${RESET}\n`);
          }
          continue;
        }

        // Agent loop
        process.stdout.write(`${DIM}Thinking...${RESET}`);
        let firstToken = true;

        for await (const event of this.agent.run(input)) {
          switch (event.type) {
            case "text_delta":
              if (firstToken) {
                process.stdout.write("\r            \r");
                process.stdout.write(CYAN);
                firstToken = false;
              }
              process.stdout.write(event.text);
              break;

            case "tool_call":
              if (!firstToken) {
                // End any ongoing text output
                process.stdout.write(RESET + "\n");
              } else {
                process.stdout.write("\r            \r");
              }
              firstToken = true; // reset for next text block
              console.log(
                `${YELLOW}> ${event.name}(${this.formatParams(event.params)})${RESET}`,
              );
              break;

            case "tool_result": {
              const status = event.result.success
                ? `${GREEN}ok${RESET}`
                : `${RED}error${RESET}`;
              const output = event.result.success
                ? event.result.output
                : event.result.error ?? "Unknown error";
              console.log(
                `${DIM}  [${status}${DIM}] ${this.truncate(output)}${RESET}`,
              );
              console.log();
              process.stdout.write(`${DIM}Thinking...${RESET}`);
              break;
            }

            case "done":
              if (!firstToken) {
                process.stdout.write(RESET);
              } else {
                process.stdout.write("\r            \r");
              }
              console.log(
                `\n${DIM}[tokens: ${event.usage.totalInputTokens} in / ${event.usage.totalOutputTokens} out]${RESET}\n`,
              );
              break;

            case "error":
              if (firstToken) {
                process.stdout.write("\r            \r");
              }
              process.stdout.write(RESET);
              console.error(`\n${RED}Error: ${event.message}${RESET}\n`);
              break;
          }
        }
      }
    } finally {
      process.removeListener("SIGINT", handleSigint);
      rl.close();
    }
  }
}
