import * as readline from "node:readline/promises";
import { AgentLoop } from "./AgentLoop.ts";
import { Conversation } from "./Conversation.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { Database, Session } from "../db/Database.ts";
import type { Message } from "../types/message.ts";

// ANSI colors
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";

const MAX_RESULT_PREVIEW = 200;

const COMMANDS = [
  "/help",
  "/clear",
  "/model ",
  "/tools",
  "/sessions",
  "/switch ",
  "/new",
  "/delete ",
  "/rename ",
  "/history",
  "/quit",
  "/exit",
];

export class Repl {
  private agent!: AgentLoop;
  private client: LLMProvider;
  private conversation!: Conversation;
  private toolRegistry: ToolRegistry;
  private db: Database;

  constructor(
    db: Database,
    client: LLMProvider,
    toolRegistry: ToolRegistry,
  ) {
    this.db = db;
    this.client = client;
    this.toolRegistry = toolRegistry;
  }

  // --- Session switching ---

  private switchSession(conversation: Conversation): void {
    this.conversation = conversation;
    this.agent = new AgentLoop(this.client, this.toolRegistry, conversation);
  }

  private getSessionLabel(): string {
    const session = this.db.getSession(this.conversation.getSessionId());
    const title = session?.title ?? "New chat";
    return title.length > 15 ? title.slice(0, 15) : title;
  }

  private getPrompt(): string {
    return `${DIM}[${this.getSessionLabel()}]${RESET} > `;
  }

  // --- Session picker at startup ---

  private async pickSession(rl: readline.Interface): Promise<void> {
    const sessions = this.listVisibleSessions(5);

    if (sessions.length === 0) {
      // No existing sessions — create a fresh one
      this.switchSession(Conversation.createNew(this.db));
      return;
    }

    console.log(`\n${BOLD}Recent sessions:${RESET}`);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      const title = s.title ?? "Untitled";
      const time = formatTime(s.updated_at);
      console.log(`  ${YELLOW}${i + 1}${RESET}. ${title} ${DIM}(${time})${RESET}`);
    }
    console.log(`  ${YELLOW}n${RESET}. Start new session`);
    console.log();

    let answer: string;
    try {
      answer = await rl.question("Choose session: ");
    } catch {
      this.switchSession(Conversation.createNew(this.db));
      return;
    }

    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "n" || trimmed === "") {
      this.switchSession(Conversation.createNew(this.db));
      return;
    }

    const idx = parseInt(trimmed, 10);
    if (idx >= 1 && idx <= sessions.length) {
      const chosen = sessions[idx - 1]!;
      const conv = Conversation.loadExisting(this.db, chosen.id);
      this.switchSession(conv);
      this.printRecentMessages(3);
    } else {
      this.switchSession(Conversation.createNew(this.db));
    }
  }

  // --- Help ---

  private get help(): string {
    return `Available commands:
  /help             Show this help message
  /sessions         List all sessions
  /switch <n|id>    Switch to another session
  /new              Create a new session
  /delete <n|id>    Delete a session
  /rename <title>   Rename current session
  /history          Show recent messages
  /clear            Clear conversation history (in-memory)
  /model <name>     Switch model (e.g. /model ernie-4.5-8k)
  /tools            List registered tools
  /quit             Exit the chat
  /exit             Exit the chat

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

  // --- Session commands ---

  private handleSessions(): void {
    const sessions = this.listVisibleSessions(50);
    if (sessions.length === 0) {
      console.log("No sessions.\n");
      return;
    }
    console.log(`${BOLD}Sessions:${RESET}`);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      const title = s.title ?? "Untitled";
      const msgCount = this.db.getMessageCount(s.id);
      const time = formatTime(s.updated_at);
      const current = s.id === this.conversation.getSessionId() ? ` ${CYAN}*${RESET}` : "";
      console.log(
        `  ${YELLOW}${i + 1}${RESET}. ${title} ${DIM}(${msgCount} msgs, ${time})${RESET}${current}`
      );
    }
    console.log();
  }

  private handleSwitch(arg: string): void {
    const sessions = this.listVisibleSessions(50);
    const target = this.resolveSession(arg, sessions);
    if (!target) {
      console.log(`${RED}Session not found: ${arg}${RESET}\n`);
      return;
    }
    if (target.id === this.conversation.getSessionId()) {
      console.log("Already on this session.\n");
      return;
    }
    const conv = Conversation.loadExisting(this.db, target.id);
    this.switchSession(conv);
    const title = target.title ?? "Untitled";
    console.log(`Switched to: ${YELLOW}${title}${RESET}`);
    this.printRecentMessages(3);
    console.log();
  }

  private handleNew(): void {
    const conv = Conversation.createNew(this.db);
    this.switchSession(conv);
    console.log("New session created.\n");
  }

  private async handleDelete(arg: string, rl: readline.Interface): Promise<void> {
    const sessions = this.listVisibleSessions(50);
    const target = this.resolveSession(arg, sessions);
    if (!target) {
      console.log(`${RED}Session not found: ${arg}${RESET}\n`);
      return;
    }
    const title = target.title ?? "Untitled";
    let confirm: string;
    try {
      confirm = await rl.question(`Delete "${title}"? (y/N) `);
    } catch {
      return;
    }
    if (confirm.trim().toLowerCase() !== "y") {
      console.log("Cancelled.\n");
      return;
    }
    const wasCurrent = target.id === this.conversation.getSessionId();
    this.db.deleteSession(target.id);
    console.log(`Deleted: ${title}`);

    if (wasCurrent) {
      const conv = Conversation.createNew(this.db);
      this.switchSession(conv);
      console.log("Created new session.\n");
    } else {
      console.log();
    }
  }

  private handleRename(newTitle: string): void {
    if (!newTitle) {
      console.log(`Usage: /rename <new title>\n`);
      return;
    }
    this.conversation.updateSessionTitle(newTitle);
    console.log(`Session renamed to: ${YELLOW}${newTitle}${RESET}\n`);
  }

  private handleHistory(): void {
    const messages = this.conversation.getMessages();
    const recent = messages.slice(-20);
    if (recent.length === 0) {
      console.log("No messages in this session.\n");
      return;
    }
    console.log(`${BOLD}Recent messages:${RESET}`);
    for (const msg of recent) {
      const role = msg.role === "user" ? `${GREEN}user${RESET}` : `${CYAN}assistant${RESET}`;
      const text = summarizeContent(msg);
      console.log(`  ${role}: ${DIM}${text}${RESET}`);
    }
    console.log();
  }

  // --- Helpers ---

  /** List sessions, filtering out empty ones (no title and no messages). */
  private listVisibleSessions(limit: number): Session[] {
    return this.db.listSessions(limit)
      .filter((s) => s.title !== null || this.db.getMessageCount(s.id) > 0);
  }

  private resolveSession(
    arg: string,
    sessions: Array<{ id: string; title: string | null }>
  ): { id: string; title: string | null } | null {
    const idx = parseInt(arg, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
      return sessions[idx - 1] ?? null;
    }
    // Try matching by id prefix
    return sessions.find((s) => s.id.startsWith(arg)) ?? null;
  }

  private printRecentMessages(n: number): void {
    const messages = this.conversation.getMessages();
    const recent = messages.slice(-n);
    if (recent.length === 0) return;
    console.log(`${DIM}--- recent messages ---${RESET}`);
    for (const msg of recent) {
      const role = msg.role === "user" ? `${GREEN}user${RESET}` : `${CYAN}assistant${RESET}`;
      const text = summarizeContent(msg);
      console.log(`  ${role}: ${DIM}${text}${RESET}`);
    }
    console.log(`${DIM}----------------------${RESET}`);
  }

  private formatParams(params: Record<string, unknown>): string {
    const entries = Object.entries(params);
    if (entries.length === 0) return "{}";
    const parts = entries.map(([k, v]) => {
      const val =
        typeof v === "string"
          ? v.length > 60
            ? `"${v.slice(0, 57)}..."`
            : `"${v}"`
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

  // --- Main loop ---

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
    await this.pickSession(rl);

    let closed = false;
    rl.on("close", () => {
      closed = true;
    });

    const handleSigint = async () => {
      console.log(`\n${RESET}Bye!`);
      await this.agent.waitForTitle(3000);
      rl.close();
      this.db.close();
      process.exit(0);
    };
    const sigintWrapper = () => { handleSigint(); };
    process.on("SIGINT", sigintWrapper);

    try {
      while (!closed) {
        let input: string;
        try {
          input = await rl.question(this.getPrompt());
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

        if (input === "/sessions") {
          this.handleSessions();
          continue;
        }

        if (input.startsWith("/switch")) {
          const arg = input.slice(7).trim();
          if (!arg) {
            console.log("Usage: /switch <number or id>\n");
          } else {
            this.handleSwitch(arg);
          }
          continue;
        }

        if (input === "/new") {
          this.handleNew();
          continue;
        }

        if (input.startsWith("/delete")) {
          const arg = input.slice(7).trim();
          if (!arg) {
            console.log("Usage: /delete <number or id>\n");
          } else {
            await this.handleDelete(arg, rl);
          }
          continue;
        }

        if (input.startsWith("/rename")) {
          this.handleRename(input.slice(7).trim());
          continue;
        }

        if (input === "/history") {
          this.handleHistory();
          continue;
        }

        if (input.startsWith("/model")) {
          const newModel = input.slice(6).trim();
          if (!newModel) {
            console.log(
              `Current model: ${YELLOW}${this.client.getModel()}${RESET}`
            );
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
                process.stdout.write(RESET + "\n");
              } else {
                process.stdout.write("\r            \r");
              }
              firstToken = true;
              console.log(
                `${YELLOW}> ${event.name}(${this.formatParams(event.params)})${RESET}`
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
                `${DIM}  [${status}${DIM}] ${this.truncate(output)}${RESET}`
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
                `\n${DIM}[tokens: ${event.usage.totalInputTokens} in / ${event.usage.totalOutputTokens} out]${RESET}\n`
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
      process.removeListener("SIGINT", sigintWrapper);
      await this.agent.waitForTitle(3000);
      rl.close();
      this.db.close();
    }
  }
}

// --- Utility functions ---

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function summarizeContent(msg: Message): string {
  if (typeof msg.content === "string") {
    return msg.content.length > 80 ? msg.content.slice(0, 80) + "..." : msg.content;
  }
  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content) {
      if ("text" in block && block.type === "text") {
        parts.push(block.text);
      } else if ("name" in block && block.type === "tool_use") {
        parts.push(`[tool: ${block.name}]`);
      } else if (block.type === "tool_result") {
        parts.push(`[result: ${block.tool_use_id}]`);
      }
    }
    const joined = parts.join(" ");
    return joined.length > 80 ? joined.slice(0, 80) + "..." : joined;
  }
  return String(msg.content).slice(0, 80);
}
