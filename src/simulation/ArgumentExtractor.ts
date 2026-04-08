import type { LLMProvider } from "../llm/types";
import type { ArgumentNode } from "./types";
import type { Message } from "../types/message";

// TODO 格式化输出，而不是依赖prompt
const EXTRACT_PROMPT = (personaNames: string[]) =>
  `Analyze this discussion transcript between ${personaNames.join(", ")}. Extract the key arguments as a JSON array. Each argument: { topic: short title, description: one sentence, supporters: [names who support], opposers: [names who oppose], consensusLevel: 0-1, status: consensus/conflict/open }. Return ONLY the JSON array, no other text.`;

/**
 * 从讨论记录中提取论点和共识状态。
 * 每轮结束后调用，使用 LLM 分析 transcript。
 */
export class ArgumentExtractor {
  async extractArguments(
    llmProvider: LLMProvider,
    transcript: string,
    personas: string[],
  ): Promise<ArgumentNode[]> {
    if (!transcript.trim()) return [];

    const messages: Message[] = [
      {
        role: "user",
        content: `${EXTRACT_PROMPT(personas)}\n\n---\n\n${transcript}`,
      },
    ];

    let fullText = "";
    try {
      const stream = llmProvider.chat(messages, {
        system: "You are a debate analyst. Extract arguments from discussion transcripts. Return ONLY valid JSON.",
      });

      for await (const event of stream) {
        if (event.type === "text_delta") {
          fullText += event.text;
        }
      }
    } catch (err) {
      console.warn(
        `[ArgumentExtractor] LLM call failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }

    return this.parseArguments(fullText);
  }

  private parseArguments(text: string): ArgumentNode[] {
    // 尝试从文本中提取 JSON 数组
    const trimmed = text.trim();

    // 尝试直接解析
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // 尝试从 markdown code block 中提取
      const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match?.[1]) {
        try {
          parsed = JSON.parse(match[1].trim());
        } catch {
          return [];
        }
      } else {
        // 尝试找到第一个 [ 和最后一个 ] 之间的内容
        const start = trimmed.indexOf("[");
        const end = trimmed.lastIndexOf("]");
        if (start !== -1 && end > start) {
          try {
            parsed = JSON.parse(trimmed.slice(start, end + 1));
          } catch {
            return [];
          }
        } else {
          return [];
        }
      }
    }

    if (!Array.isArray(parsed)) return [];

    // 校验每个元素的格式
    const validated: ArgumentNode[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;

      const topic = typeof obj["topic"] === "string" ? obj["topic"] : "";
      const description =
        typeof obj["description"] === "string" ? obj["description"] : "";
      if (!topic) continue;

      const supporters = Array.isArray(obj["supporters"])
        ? obj["supporters"].filter((s): s is string => typeof s === "string")
        : [];
      const opposers = Array.isArray(obj["opposers"])
        ? obj["opposers"].filter((s): s is string => typeof s === "string")
        : [];

      const consensusLevel =
        typeof obj["consensusLevel"] === "number"
          ? Math.max(0, Math.min(1, obj["consensusLevel"]))
          : 0.5;

      const rawStatus = typeof obj["status"] === "string" ? obj["status"] : "open";
      const status: ArgumentNode["status"] =
        rawStatus === "consensus" || rawStatus === "conflict"
          ? rawStatus
          : "open";

      validated.push({
        topic,
        description,
        supporters,
        opposers,
        consensusLevel,
        status,
      });
    }

    return validated;
  }
}
