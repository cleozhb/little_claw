import type { Database, MessageRecord } from "../db/Database.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { AssistantContentBlock, Message, ToolResultBlock } from "../types/message.ts";
import { type AppClock, systemAppClock } from "../utils/AppClock.ts";
import { generateSummaryResult } from "./SummaryGenerator.ts";
import type { LongTermMemoryExtractor, LongTermMemoryResult } from "./LongTermMemoryExtractor.ts";
import type { MemoryIndexer } from "./MemoryIndexer.ts";
import type { MemoryStore } from "./MemoryStore.ts";

export type MemoryFlushReason =
  | "interval"
  | "session_switch"
  | "idle"
  | "execution_end"
  | "shutdown";

export interface FlushOptions {
  reason: MemoryFlushReason;
  force?: boolean;
}

type DailyStatus = "written" | "already_written" | "no_content" | "skipped";
type LongTermStatus = "updated" | "unchanged" | "no_candidate" | "skipped";

export interface FlushReport {
  sessionId: string;
  daily: { status: DailyStatus } | { status: "failed"; error: string };
  longTerm: { status: LongTermStatus } | { status: "failed"; error: string };
}

const INTERVAL_ASSISTANT_TURNS = 5;

export class MemoryFlushCoordinator {
  private queues = new Map<string, Promise<void>>();

  constructor(
    private db: Database,
    private llmProvider: LLMProvider,
    private memoryStore: MemoryStore,
    private longTermExtractor?: LongTermMemoryExtractor,
    private memoryIndexer?: MemoryIndexer,
    private clock: AppClock = systemAppClock,
  ) {}

  flushSession(sessionId: string, options: FlushOptions): Promise<FlushReport> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.flushSessionInner(sessionId, options));
    const tail = run.then(() => undefined, () => undefined);
    this.queues.set(sessionId, tail);
    return run.finally(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
    });
  }

  async flushAll(sessionIds: string[], reason: "shutdown" = "shutdown"): Promise<FlushReport[]> {
    return Promise.all(
      [...new Set(sessionIds)].map((sessionId) =>
        this.flushSession(sessionId, { reason, force: true })
      ),
    );
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.queues.values()]);
  }

  private async flushSessionInner(sessionId: string, options: FlushOptions): Promise<FlushReport> {
    const session = this.db.getSession(sessionId);
    if (!session) {
      return {
        sessionId,
        daily: { status: "failed", error: `Session not found: ${sessionId}` },
        longTerm: { status: "failed", error: `Session not found: ${sessionId}` },
      };
    }

    const state = this.db.getMemoryFlushState(sessionId);
    const dailyRecords = this.db.getMessagesAfter(sessionId, state.dailyCursorMessageId);
    const longTermRecords = this.db.getMessagesAfter(sessionId, state.longTermCursorMessageId);
    const force = options.force === true;
    if (!force && countCompletedAssistantTurns(dailyRecords) < INTERVAL_ASSISTANT_TURNS) {
      return { sessionId, daily: { status: "skipped" }, longTerm: { status: "skipped" } };
    }

    const now = this.clock.now();
    const daily = await this.flushDaily(sessionId, dailyRecords, now, options.reason);
    const longTerm = await this.flushLongTerm(sessionId, longTermRecords, now);
    return { sessionId, daily, longTerm };
  }

  private async flushDaily(
    sessionId: string,
    records: MessageRecord[],
    now: Date,
    reason: MemoryFlushReason,
  ): Promise<FlushReport["daily"]> {
    if (records.length === 0) return { status: "skipped" };
    const last = records.at(-1)!;
    const messages = recordsToMessages(records, this.db);
    const generated = await generateSummaryResult(this.llmProvider, messages, messages.length);
    if (generated.status === "failed") return generated;
    if (generated.status === "no_content") {
      this.db.updateDailyCursor(sessionId, last.id, now.toISOString());
      return { status: "no_content" };
    }
    const summary = generated.summary;

    const first = records[0]!;
    const flushId = hashText(`${sessionId}:${first.id}:${last.id}:daily-format-v1`);
    const marker = `<!-- little-claw:daily-flush id="${flushId}" -->`;
    const session = this.db.getSession(sessionId);
    const entry = formatDailyEntry({
      marker,
      summary,
      sessionId,
      title: session?.title ?? null,
      messageCount: records.length,
      reason,
      time: this.clock.formatTime(now),
    });
    const path = `daily/${this.clock.formatDate(now)}.md`;
    try {
      const result = await this.memoryStore.appendMemoryOnce(path, entry, marker);
      this.db.updateSessionSummary(sessionId, summary);
      this.db.updateDailyCursor(sessionId, last.id, now.toISOString());
      this.memoryIndexer?.reindexFile(path).catch(() => {});
      return { status: result.status };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async flushLongTerm(
    sessionId: string,
    records: MessageRecord[],
    now: Date,
  ): Promise<FlushReport["longTerm"]> {
    if (records.length === 0 || !this.longTermExtractor) return { status: "skipped" };
    const last = records.at(-1)!;
    let result: LongTermMemoryResult;
    try {
      result = await this.longTermExtractor.extractAndUpdate(recordsToMessages(records, this.db));
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    if (result.status === "failed") return result;
    try {
      this.db.updateLongTermCursor(sessionId, last.id, now.toISOString());
      if (result.status === "updated") {
        this.memoryIndexer?.reindexFile("MEMORY.md").catch(() => {});
      }
      return { status: result.status };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function recordsToMessages(records: MessageRecord[], db: Database): Message[] {
  const messages: Message[] = [];
  for (const record of records) {
    const parsed = parseContent(record.content);
    if (record.role === "user") {
      messages.push({ role: "user", content: typeof parsed === "string" ? parsed : String(parsed) });
      continue;
    }
    if (record.role !== "assistant") continue;
    const blocks = Array.isArray(parsed)
      ? parsed
      : [{ type: "text", text: typeof parsed === "string" ? parsed : String(parsed) }];
    messages.push({ role: "assistant", content: blocks as AssistantContentBlock[] });
    const toolResults = db.getToolResults(record.id);
    if (toolResults.length > 0) {
      const results: ToolResultBlock[] = toolResults.map((result) => ({
        type: "tool_result",
        tool_use_id: result.tool_use_id,
        content: result.tool_output,
        is_error: result.is_error === 1,
      }));
      messages.push({ role: "user", content: results });
    }
  }
  return messages;
}

function countCompletedAssistantTurns(records: MessageRecord[]): number {
  let count = 0;
  for (const record of records) {
    if (record.role !== "assistant") continue;
    const parsed = parseContent(record.content);
    if (!Array.isArray(parsed)) {
      if (String(parsed).trim()) count++;
      continue;
    }
    const hasText = parsed.some((block) => block?.type === "text" && String(block.text ?? "").trim());
    const hasToolUse = parsed.some((block) => block?.type === "tool_use");
    if (hasText && !hasToolUse) count++;
  }
  return count;
}

function parseContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function formatDailyEntry(input: {
  marker: string;
  summary: string;
  sessionId: string;
  title: string | null;
  messageCount: number;
  reason: MemoryFlushReason;
  time: string;
}): string {
  return [
    input.marker,
    `## ${input.time} - Conversation summary`,
    "",
    input.title ? `- Session: ${input.title} (${input.sessionId})` : `- Session: ${input.sessionId}`,
    `- Messages: ${input.messageCount}`,
    `- Trigger: ${input.reason}`,
    "",
    input.summary.trim(),
    "",
  ].join("\n");
}

function hashText(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex").slice(0, 32);
}
