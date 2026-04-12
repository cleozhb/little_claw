import type { LLMProvider } from "../llm/types";
import type { ParsedPersona } from "./types";
import { createLogger } from "../utils/logger";

const log = createLogger("SpeakerSelector");

/**
 * Free 模式下的动态发言人选择器。
 * 内部追踪每个 persona 的发言间隔，超过阈值时强制选择被遗忘的人。
 * 正常情况下调用 LLM 选择下一个发言人。
 */
export class SpeakerSelector {
  /** 记录每个 persona 距上次发言的步数（name -> steps since last spoke） */
  private stepsSinceSpoke = new Map<string, number>();

  /**
   * 初始化所有 persona 的发言间隔追踪。
   */
  init(personas: ParsedPersona[]): void {
    this.stepsSinceSpoke.clear();
    for (const p of personas) {
      this.stepsSinceSpoke.set(p.name, 0);
    }
  }

  /**
   * 记录某人刚刚发言，重置其计数，其他人 +1。
   */
  recordSpoke(speaker: string): void {
    for (const [name, count] of this.stepsSinceSpoke) {
      if (name === speaker) {
        this.stepsSinceSpoke.set(name, 0);
      } else {
        this.stepsSinceSpoke.set(name, count + 1);
      }
    }
  }

  /**
   * 选择下一个发言人。
   *
   * 1. 如果某人超过 N 步（N = 候选人数 * 2）没说话，强制选他。
   * 2. 否则调用 LLM 从 transcript 上下文中选择最合适的下一个发言人。
   * 3. 如果 LLM 返回的名字不在候选列表中，随机选一个（排除上一个发言人）。
   */
  async selectNextSpeaker(
    llmProvider: LLMProvider,
    transcript: string,
    personas: ParsedPersona[],
    lastSpeaker: string,
  ): Promise<{ name: string; reason: string }> {
    const candidates = personas.filter((p) => p.name !== lastSpeaker);
    if (candidates.length === 0) {
      // 只剩一个人了
      return { name: personas[0]!.name, reason: "Only participant remaining" };
    }

    // --- 防遗忘检查 ---
    const threshold = personas.length * 2;
    let forgotten: string | null = null;
    let maxSteps = 0;

    for (const p of candidates) {
      const steps = this.stepsSinceSpoke.get(p.name) ?? 0;
      if (steps >= threshold && steps > maxSteps) {
        maxSteps = steps;
        forgotten = p.name;
      }
    }

    if (forgotten) {
      const reason = `Forced: ${forgotten} hasn't spoken for ${maxSteps} turns`;
      log.step("Speaker forced (anti-forgetting)", { persona: forgotten, steps: maxSteps, threshold });
      return { name: forgotten, reason };
    }

    // --- LLM 选择 ---
    const participantList = personas
      .map((p) => `- ${p.name} (${p.role})`)
      .join("\n");

    const systemPrompt = `You are moderating a free-form discussion between these participants:
${participantList}

Last speaker was: ${lastSpeaker}

Based on the discussion so far, who should speak next?
Consider:
- Who was directly addressed or challenged?
- Who hasn't spoken recently?
- Who has relevant expertise for the current topic?
- Don't pick the same person twice in a row

Respond with ONLY the persona name, nothing else.`;

    // 截取 transcript 末尾以节省 token
    const recentTranscript = transcript.length > 2000
      ? transcript.slice(-2000)
      : transcript;

    const messages: Array<{ role: "user"; content: string }> = [
      { role: "user", content: `Recent discussion:\n${recentTranscript}` },
    ];

    // --- LLM 选择（带容错）---
    let fullText = "";
    try {
      const stream = llmProvider.chat(messages, {
        system: systemPrompt,
      });

      for await (const event of stream) {
        if (event.type === "text_delta") {
          fullText += event.text;
        }
      }
    } catch (err) {
      // LLM 调用失败，fallback 到随机选择
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn("LLM speaker selection failed, using random fallback", errMsg);
      const randomPick = candidates[Math.floor(Math.random() * candidates.length)]!;
      return { name: randomPick.name, reason: `Random fallback (LLM error: ${errMsg})` };
    }

    const chosen = fullText.trim();
    log.step("LLM speaker selection", { chosen, candidates: candidates.map((p) => p.name) });

    // 验证 LLM 返回的名字是否在候选人列表中
    const matched = candidates.find(
      (p) => p.name.toLowerCase() === chosen.toLowerCase()
        || p.name.toLowerCase().startsWith(chosen.toLowerCase())
        || chosen.toLowerCase().includes(p.name.toLowerCase()),
    );

    if (matched) {
      const reason = `LLM selected: ${chosen}`;
      return { name: matched.name, reason };
    }

    // Fallback：随机选一个（排除上一个发言人）
    const randomPick = candidates[Math.floor(Math.random() * candidates.length)]!;
    const reason = `Random fallback (LLM returned "${chosen}" which didn't match any candidate)`;
    log.warn("LLM speaker selection fallback", `llmReturned=${chosen}, picked=${randomPick.name}`);
    return { name: randomPick.name, reason };
  }
}
