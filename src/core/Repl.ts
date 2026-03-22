import * as readline from "node:readline/promises";
import type { QianfanClient } from "../llm/QianfanClient.ts";
import type { Conversation } from "./Conversation.ts";

// ANSI colors
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

const HELP = `Available commands:
  /help          Show this help message
  /clear         Clear conversation history
  /model <name>  Switch model (e.g. /model ernie-4.5-8k)
  /quit          Exit the chat
  /exit          Exit the chat

Multi-line input:
  Type ${CYAN}"""${RESET} to start, type ${CYAN}"""${RESET} again to send.
`;

export class Repl {
  private client: QianfanClient;
  private conversation: Conversation;

  constructor(client: QianfanClient, conversation: Conversation) {
    this.client = client;
    this.conversation = conversation;
  }

  private printWelcome(): void {
    console.log(`
${CYAN}Welcome to Little Claw Chat!${RESET}
Model: ${YELLOW}${this.client.getModel()}${RESET}
Type your message and press Enter to chat.
Type ${CYAN}/help${RESET} for available commands.
`);
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
          console.log(HELP);
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

        // Normal chat
        this.conversation.addUser(input);

        process.stdout.write(`${DIM}Thinking...${RESET}`);
        let firstToken = true;
        let fullResponse = "";

        try {
          const gen = this.client.chat(
            this.conversation.getMessages(),
            this.conversation.getSystemPrompt(),
          );

          let result = await gen.next();
          while (!result.done) {
            if (firstToken) {
              process.stdout.write("\r            \r");
              process.stdout.write(CYAN);
              firstToken = false;
            }
            process.stdout.write(result.value);
            fullResponse += result.value;
            result = await gen.next();
          }

          process.stdout.write(RESET);

          // result.value is the ChatResult returned from the generator
          const usage = result.value;
          if (usage && (usage.inputTokens || usage.outputTokens)) {
            console.log(`\n${DIM}[tokens: ${usage.inputTokens} in / ${usage.outputTokens} out]${RESET}\n`);
          } else {
            console.log("\n");
          }

          this.conversation.addAssistant(fullResponse);
        } catch (err: unknown) {
          if (firstToken) {
            process.stdout.write("\r            \r");
          }
          process.stdout.write(RESET);

          // Remove the failed user message from conversation
          this.conversation.popLast();

          if (isRateLimitError(err)) {
            console.error(`\n${RED}Rate limited (429). Please wait a moment and try again.${RESET}\n`);
          } else if (isTimeoutError(err)) {
            console.error(`\n${RED}Request timed out (30s). Please try again.${RESET}\n`);
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`\n${RED}Error: ${msg}${RESET}\n`);
          }
          continue;
        }
      }
    } finally {
      process.removeListener("SIGINT", handleSigint);
      rl.close();
    }
  }
}

function isRateLimitError(err: unknown): boolean {
  if (err && typeof err === "object" && "status" in err) {
    return (err as { status: number }).status === 429;
  }
  return false;
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "APIConnectionTimeoutError" || err.message.includes("timed out");
  }
  return false;
}
