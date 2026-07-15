/**
 * Maintains memory/MEMORY.md as the durable personal memory truth source.
 */

import type { LLMProvider } from "../llm/types.ts";
import type { Message } from "../types/message.ts";
import type { MemoryStore } from "./MemoryStore.ts";

const MEMORY_PATH = "MEMORY.md";

export type LongTermMemoryResult =
  | { status: "updated"; contentHash: string }
  | { status: "unchanged" }
  | { status: "no_candidate" }
  | { status: "failed"; error: string };

export class LongTermMemoryExtractor {
  constructor(
    private memoryStore: MemoryStore,
    private llmProvider: LLMProvider,
  ) {}

  async extractAndUpdate(messages: Message[]): Promise<LongTermMemoryResult> {
    const conversationText = collectConversationText(messages);
    if (!conversationText.trim()) return { status: "no_candidate" };
    return this.mergeMemory(conversationText);
  }

  async mergeMemory(newInformation: string): Promise<LongTermMemoryResult> {
    let failure = "Long-term memory update failed";
    let updatedContentHash: string | undefined;
    try {
      const result = await this.memoryStore.updateMemory(MEMORY_PATH, async (currentMemory) => {
        let merged: string;
        try {
          merged = await this.runLLM(currentMemory, newInformation);
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
          return { action: "keep", status: "failed" as const };
        }

        const cleaned = merged.trim();
        if (cleaned === "NONE") return { action: "keep", status: "no_candidate" as const };
        if (!cleaned) {
          failure = "Long-term memory model returned an empty response";
          return { action: "keep", status: "failed" as const };
        }
        const currentTrimmed = currentMemory.trim();
        if (
          currentTrimmed.length > 0 &&
          !isDefaultMemoryTemplate(currentTrimmed) &&
          cleaned.length < currentTrimmed.length * 0.5
        ) {
          failure = "Long-term memory model returned a suspiciously truncated document";
          return { action: "keep", status: "failed" as const };
        }
        if (cleaned === currentTrimmed) {
          return { action: "keep", status: "unchanged" as const };
        }
        updatedContentHash = hashText(cleaned);
        return { action: "write", content: cleaned, status: "updated" as const };
      });

      if (result.status === "failed") return { status: "failed", error: failure };
      if (result.status === "updated") {
        return { status: "updated", contentHash: updatedContentHash ?? "" };
      }
      return { status: result.status };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async runLLM(currentMemory: string, newInformation: string): Promise<string> {
    const prompt = buildPrompt(currentMemory, newInformation);
    const messages = [{ role: "user" as const, content: prompt }];
    let result = "";
    for await (const event of this.llmProvider.chat(messages)) {
      if (event.type === "text_delta") {
        result += event.text;
      }
    }
    return result;
  }
}

function hashText(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex").slice(0, 32);
}

function isDefaultMemoryTemplate(content: string): boolean {
  return content.startsWith("# Memory") &&
    content.includes("Long-term personal memory and durable collaboration preferences live here.");
}

function collectConversationText(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      parts.push(`[${msg.role}] ${msg.content}`);
      continue;
    }
    if (msg.role === "assistant") {
      const text = msg.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text.trim()) parts.push(`[assistant] ${text}`);
    }
  }
  return parts.join("\n\n");
}

function buildPrompt(currentMemory: string, newInformation: string): string {
  return `你在维护一份用户与 agent 之间的长期个人记忆（memory/MEMORY.md）。请根据下面的「新信息」更新「当前记忆」，输出合并后的【完整 MEMORY.md】。

规则：
- 只保留长期稳定、未来对话明显有用的信息：用户身份、工作背景、长期偏好、协作习惯、明确要求记住的事实。
- 不要保存短期任务流水、一次性问题、普通寒暄、已经写入项目资料库的项目正文。
- 项目相关内容只保留高层关系或入口；项目状态和资料应放在 context-hub。
- 新信息与旧信息冲突时以新信息为准，修改旧条目而不是并存。
- 保持简洁，优先用 Markdown 分节和短 bullet。
- 如果没有任何值得写入长期记忆的新内容，只输出一个词：NONE
- 只输出 MEMORY.md 正文，不要解释，不要代码块。

=== 当前记忆 ===
${currentMemory || "(空)"}

=== 新信息 ===
${newInformation}

=== 合并后的完整 MEMORY.md ===`;
}
