import type { Message } from "../types/message.ts";

// ---------------------------------------------------------------------------
// Token 预算管理 — 按优先级分配 context window
// ---------------------------------------------------------------------------

/** 粗略估算 token 数：英文字符数/4 + 中文字符数*1.5 */
export function estimateTokens(text: string): number {
  const chineseChars = text.match(/[\u4e00-\u9fff]/g);
  const chineseCount = chineseChars ? chineseChars.length : 0;
  const nonChineseCount = text.length - chineseCount;
  return Math.ceil(nonChineseCount / 4 + chineseCount * 1.5);
}

export interface BudgetAllocation {
  systemPrompt: string;
  userMessage: string;
  conversationHistory: Message[];
  longTermMemory: string[];
  skillPrompt: string;
  /** 文件记忆层：SOUL.md 内容 */
  soulPrompt: string;
  /** 文件记忆层：USER.md 内容 */
  userPreferences: string;
  /** 文件记忆层：MEMORY.md 内容 */
  fileMemory: string;
}

export interface BudgetInput {
  systemPrompt: string;
  userMessage: string;
  conversationHistory: Message[];
  longTermMemory: string[];
  skillPrompt: string;
  /** 模型的总 token 上限（默认 128000） */
  modelMaxTokens?: number;
  /** 留给 context 的比例（默认 0.5，即一半留给对话） */
  contextRatio?: number;
  /** 文件记忆层：SOUL.md 内容 */
  soulPrompt?: string;
  /** 文件记忆层：USER.md 内容 */
  userPreferences?: string;
  /** 文件记忆层：MEMORY.md 内容 */
  fileMemory?: string;
}

/**
 * 按优先级分配 token 预算，超出时从低优先级开始裁剪。
 *
 * 优先级（从高到低）：
 *   1. System prompt（必须保留）
 *   2. SOUL.md — Agent 身份准则（必须保留）
 *   3. USER.md — 用户偏好（必须保留）
 *   4. MEMORY.md — 长期知识（必须保留）
 *   5. 用户新消息（必须保留）
 *   6. 最近对话历史（尽量保留）
 *   7. 向量检索结果 — 长期记忆（有预算就加）
 *   8. Skill 指令（有预算就加）
 */
export function allocateBudget(input: BudgetInput): BudgetAllocation {
  const modelMax = input.modelMaxTokens ?? 128_000;
  const ratio = input.contextRatio ?? 0.5;
  const totalBudget = Math.floor(modelMax * ratio);

  // 第 1~5 优先级：system prompt + 文件记忆 + 用户消息（必须保留）
  const systemTokens = estimateTokens(input.systemPrompt);
  const userTokens = estimateTokens(input.userMessage);

  const soulPrompt = input.soulPrompt ?? "";
  const userPreferences = input.userPreferences ?? "";
  const fileMemory = input.fileMemory ?? "";

  const soulTokens = estimateTokens(soulPrompt);
  const userPrefTokens = estimateTokens(userPreferences);
  const fileMemTokens = estimateTokens(fileMemory);

  let remaining = totalBudget - systemTokens - soulTokens - userPrefTokens - fileMemTokens - userTokens;

  if (remaining <= 0) {
    // 预算极端紧张，只保留必须项
    return {
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      conversationHistory: [],
      longTermMemory: [],
      skillPrompt: "",
      soulPrompt,
      userPreferences,
      fileMemory,
    };
  }

  // 第 6 优先级：对话历史（从最新开始倒着保留）
  const keptHistory: Message[] = [];
  for (let i = input.conversationHistory.length - 1; i >= 0; i--) {
    const msg = input.conversationHistory[i]!;
    const msgTokens = estimateTokens(serializeMessage(msg));
    if (msgTokens > remaining) break;
    remaining -= msgTokens;
    keptHistory.unshift(msg);
  }

  // 第 7 优先级：向量检索长期记忆
  const keptMemory: string[] = [];
  for (const mem of input.longTermMemory) {
    const memTokens = estimateTokens(mem);
    if (memTokens > remaining) break;
    remaining -= memTokens;
    keptMemory.push(mem);
  }

  // 第 8 优先级：Skill 指令
  let keptSkillPrompt = "";
  const skillTokens = estimateTokens(input.skillPrompt);
  if (input.skillPrompt && skillTokens <= remaining) {
    keptSkillPrompt = input.skillPrompt;
    remaining -= skillTokens;
  }

  return {
    systemPrompt: input.systemPrompt,
    userMessage: input.userMessage,
    conversationHistory: keptHistory,
    longTermMemory: keptMemory,
    skillPrompt: keptSkillPrompt,
    soulPrompt,
    userPreferences,
    fileMemory,
  };
}

/** 将 Message 序列化为字符串用于 token 估算 */
function serializeMessage(msg: Message): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  return JSON.stringify(msg.content);
}

/**
 * 将长期记忆列表格式化为注入 system prompt 的 XML 块。
 * 如果列表为空则返回空字符串。
 */
export function formatLongTermMemory(memories: string[]): string {
  if (memories.length === 0) return "";

  const items = memories.map((m) => `- ${m}`).join("\n");
  return `<long_term_memory>
The following are relevant memories from previous conversations:
${items}
</long_term_memory>`;
}
