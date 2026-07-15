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

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  const suffix = "\n\n[Memory truncated to context budget]";
  const suffixTokens = estimateTokens(suffix);
  if (suffixTokens >= maxTokens) {
    return truncateRawToTokenBudget(suffix, maxTokens);
  }
  const contentBudget = maxTokens - suffixTokens;
  return `${truncateRawToTokenBudget(text, contentBudget).trimEnd()}${suffix}`;
}

function truncateRawToTokenBudget(text: string, maxTokens: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

export function limitStringsToTokenBudget(values: string[], maxTokens: number): string[] {
  const result: string[] = [];
  let remaining = maxTokens;
  for (const value of values) {
    const tokens = estimateTokens(value);
    if (tokens <= remaining) {
      result.push(value);
      remaining -= tokens;
      continue;
    }
    if (remaining > 0) result.push(truncateToTokenBudget(value, remaining));
    break;
  }
  return result;
}

export interface BudgetAllocation {
  systemPrompt: string;
  userMessage: string;
  conversationHistory: Message[];
  longTermMemory: string[];
  skillPrompt: string;
  /** Memory: 长期个人记忆（memory/MEMORY.md） */
  identity: string;
  /** Memory: 收件箱（memory/inbox.md） */
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
  /** Memory: 长期个人记忆（memory/MEMORY.md） */
  identity?: string;
  /** Memory: 收件箱（memory/inbox.md） */
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
 *   2. identity — 用户身份 profile.md（必须保留）
 *   3. inbox — 收件箱 inbox.md（必须保留）
 *   4. contextMap — L0 全局地图（必须保留，~500 tokens）
 *   5. 用户新消息（必须保留）
 *   6. 最近对话历史（尽量保留）
 *   7. contextOverviews — L1 检索命中的 overview（有预算就加）
 *   8. 向量检索结果 — 长期记忆（有预算就加）
 *   9. Skill 指令（有预算就加）
 */
export function allocateBudget(input: BudgetInput): BudgetAllocation {
  const modelMax = input.modelMaxTokens ?? 128_000;
  const ratio = input.contextRatio ?? 0.5;
  const totalBudget = Math.floor(modelMax * ratio);

  // 必须保留项
  const systemTokens = estimateTokens(input.systemPrompt);
  const userTokens = estimateTokens(input.userMessage);

  const identity = input.identity ?? "";
  const inbox = input.inbox ?? "";
  const contextMap = input.contextMap ?? "";

  const mustKeepTokens =
    systemTokens +
    estimateTokens(identity) +
    estimateTokens(inbox) +
    estimateTokens(contextMap) +
    userTokens;

  let remaining = totalBudget - mustKeepTokens;

  if (remaining <= 0) {
    const latestMessage = input.conversationHistory.at(-1);
    // 预算极端紧张，只保留必须项
    return {
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      conversationHistory: latestMessage ? [latestMessage] : [],
      longTermMemory: [],
      skillPrompt: "",
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
    if (msgTokens > remaining) {
      if (keptHistory.length === 0 && i === input.conversationHistory.length - 1) {
        keptHistory.unshift(msg);
      }
      break;
    }
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
