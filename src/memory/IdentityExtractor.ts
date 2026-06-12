/**
 * src/memory/IdentityExtractor.ts — 从对话中蒸馏稳定身份信息到 0-identity/profile.md
 *
 * 维护式重写（非 append）：每次把当前 profile 全文 + 新对话片段交给 LLM，
 * 要求输出合并后的完整 profile，新旧冲突以新为准。空内容/异常输出时保留原文件。
 */

import type { LLMProvider } from "../llm/types.ts";
import type { ContextHub } from "./ContextHub.ts";
import type { Message } from "../types/message.ts";

const PROFILE_PATH = "0-identity/profile.md";

export class IdentityExtractor {
  constructor(
    private contextHub: ContextHub,
    private llmProvider: LLMProvider,
  ) {}

  /**
   * 从增量消息中提取身份信息，合并重写 profile.md。
   * @returns updated 是否实际写入了文件
   */
  async extractAndUpdate(messages: Message[]): Promise<{ updated: boolean }> {
    const userText = collectUserText(messages);
    if (!userText.trim()) return { updated: false };

    const currentProfile = (await this.contextHub.readFile(PROFILE_PATH)) ?? "";

    let merged: string;
    try {
      merged = await this.runLLM(currentProfile, userText);
    } catch (err) {
      // LLM 调用失败：保留原文件，不阻塞主流程
      if (process.env.DEBUG) {
        console.error(`[debug] IdentityExtractor LLM call failed:`, err);
      }
      return { updated: false };
    }

    const cleaned = merged.trim();

    // 模型判定无新身份信息
    if (cleaned === "NONE" || cleaned === "") {
      return { updated: false };
    }

    // 容错：原本有内容，但新输出明显过短（疑似误删），保留原文件
    if (
      currentProfile.trim().length > 0 &&
      cleaned.length < currentProfile.trim().length * 0.5
    ) {
      return { updated: false };
    }

    // 内容无变化时跳过写入
    if (cleaned === currentProfile.trim()) {
      return { updated: false };
    }

    await this.contextHub.writeFile(PROFILE_PATH, cleaned, "overwrite");
    return { updated: true };
  }

  private async runLLM(currentProfile: string, userText: string): Promise<string> {
    const prompt = buildPrompt(currentProfile, userText);
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

/** 只取 user 消息文本，控制 token 消耗 */
function collectUserText(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    }
    // tool_result 类型的 user 消息（content 为数组）跳过
  }
  return parts.join("\n");
}

function buildPrompt(currentProfile: string, userText: string): string {
  return `你在维护一份用户的长期身份档案（profile.md）。请根据下面的「新对话片段」更新「当前档案」，输出合并后的【完整档案】。

规则：
- 只保留长期稳定、能帮助未来对话的身份事实：姓名、时区、性别、工作与职业、核心兴趣爱好与持续关注的领域、健康与医疗信息。
- 区分「一次性好奇」和「持续关注」：若用户在对话中【反复、多次】问到同一个人物、领域或主题，应将其记为兴趣/关注领域（如「持续关注马斯克及其公司」）；只出现一两次的零散话题则忽略。
- 忽略真正临时性的内容（任务细节、临时待办、单次闲聊）。
- 务必精简：每条一句话、抓本质即可，不要展开、不要举例、不要标注日期。整份档案控制在 20 行以内。
- 合并同类条目、去重。新信息与旧条目冲突时【以新为准】（修改而非并存）。
- 用户明确否定或不再相关的条目可删除。
- 不要生成「协作偏好」「沟通方式」这类条目，用户会自己维护。
- 如果新对话片段中没有任何值得记入档案的新身份信息，只输出一个词：NONE
- 输出格式：markdown 分节（## 基本信息 / ## 工作与兴趣 / ## 健康，没有内容的分节直接省略）。只输出档案本身，不要任何解释或代码块包裹。

=== 当前档案 ===
${currentProfile || "(空)"}

=== 新对话片段 ===
${userText}

=== 合并后的完整档案 ===`;
}
