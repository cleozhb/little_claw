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
  /** 旧系统 fallback：USER.md 内容（迁移后为空） */
  userPreferences: string;
  /** 旧系统 fallback：MEMORY.md 内容（迁移后为空） */
  fileMemory: string;
  /** 三层上下文：用户身份（0-identity/profile.md） */
  identity: string;
  /** 三层上下文：收件箱（1-inbox/inbox.md） */
  inbox: string;
  /** 三层上下文：L0 全局地图（所有 .abstract.md 拼接） */
  contextMap: string;
  /** 三层上下文：L1 检索命中的 .overview.md 内容 */
  contextOverviews: string;
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
  /** 旧系统 fallback：USER.md 内容（迁移后为空） */
  userPreferences?: string;
  /** 旧系统 fallback：MEMORY.md 内容（迁移后为空） */
  fileMemory?: string;
  /** 三层上下文：用户身份（0-identity/profile.md） */
  identity?: string;
  /** 三层上下文：收件箱（1-inbox/inbox.md） */
  inbox?: string;
  /** 三层上下文：L0 全局地图（所有 .abstract.md 拼接） */
  contextMap?: string;
  /** 三层上下文：L1 检索命中的 .overview.md 内容 */
  contextOverviews?: string;
}

/**
 * 按优先级分配 token 预算，超出时从低优先级开始裁剪。
 *
 * 优先级（从高到低）：
 *   1. System prompt（必须保留）
 *   2. SOUL.md — Agent 身份准则（必须保留）
 *   3. identity — 用户身份 profile.md（必须保留）
 *   4. inbox — 收件箱 inbox.md（必须保留）
 *   5. contextMap — L0 全局地图（必须保留，~500 tokens）
 *   6. USER.md / MEMORY.md fallback（必须保留，迁移后为空）
 *   7. 用户新消息（必须保留）
 *   8. 最近对话历史（尽量保留）
 *   9. contextOverviews — L1 检索命中的 overview（有预算就加）
 *   10. 向量检索结果 — 长期记忆（有预算就加）
 *   11. Skill 指令（有预算就加）
 */
export function allocateBudget(input: BudgetInput): BudgetAllocation {
  const modelMax = input.modelMaxTokens ?? 128_000;
  const ratio = input.contextRatio ?? 0.5;
  const totalBudget = Math.floor(modelMax * ratio);

  // 必须保留项
  const systemTokens = estimateTokens(input.systemPrompt);
  const userTokens = estimateTokens(input.userMessage);

  const soulPrompt = input.soulPrompt ?? "";
  const identity = input.identity ?? "";
  const inbox = input.inbox ?? "";
  const contextMap = input.contextMap ?? "";
  const userPreferences = input.userPreferences ?? "";
  const fileMemory = input.fileMemory ?? "";

  const mustKeepTokens =
    systemTokens +
    estimateTokens(soulPrompt) +
    estimateTokens(identity) +
    estimateTokens(inbox) +
    estimateTokens(contextMap) +
    estimateTokens(userPreferences) +
    estimateTokens(fileMemory) +
    userTokens;

  let remaining = totalBudget - mustKeepTokens;

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
      identity,
      inbox,
      contextMap,
      contextOverviews: "",
    };
  }

  // 对话历史（从最新开始倒着保留）
  const keptHistory: Message[] = [];
  for (let i = input.conversationHistory.length - 1; i >= 0; i--) {
    const msg = input.conversationHistory[i]!;
    const msgTokens = estimateTokens(serializeMessage(msg));
    if (msgTokens > remaining) break;
    remaining -= msgTokens;
    keptHistory.unshift(msg);
  }

  // L1 检索命中的 overview
  let keptOverviews = "";
  const overviewsInput = input.contextOverviews ?? "";
  const overviewTokens = estimateTokens(overviewsInput);
  if (overviewsInput && overviewTokens <= remaining) {
    keptOverviews = overviewsInput;
    remaining -= overviewTokens;
  }

  // 向量检索长期记忆
  const keptMemory: string[] = [];
  for (const mem of input.longTermMemory) {
    const memTokens = estimateTokens(mem);
    if (memTokens > remaining) break;
    remaining -= memTokens;
    keptMemory.push(mem);
  }

  // Skill 指令
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
    identity,
    inbox,
    contextMap,
    contextOverviews: keptOverviews,
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
