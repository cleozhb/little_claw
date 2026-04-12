/**
 * src/skills/tokenize.ts — 共享分词工具
 *
 * 用于 SkillIndexer 关键词提取和 SkillRetriever BM25 查询分词。
 */

const STOP_WORDS = new Set([
  "the", "and", "for", "this", "that", "with", "from", "are", "was",
  "were", "will", "have", "has", "had", "not", "but", "can", "use",
  "when", "how", "what", "which", "their", "there", "about", "into",
  "than", "them", "then", "some", "other", "should", "would", "could",
  "may", "might", "you", "your", "its", "all", "any", "each", "every",
  "both", "few", "more", "most", "such", "only", "own", "same", "too",
  "very", "just", "also", "now", "here",
]);

/**
 * 对文本做分词：提取英文词和中文词组。
 * 英文：按空格/标点 split，过滤 < 3 字符和停用词，lowercase。
 * 中文：正则提取 ≥ 2 字的连续中文。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();

  // 英文分词
  const englishTokens = lower
    .match(/[a-z]{3,}/g)
    ?.filter((t) => !STOP_WORDS.has(t)) ?? [];

  // 中文分词（提取 2 字以上连续中文）
  const chineseTokens = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? [];

  return [...englishTokens, ...chineseTokens];
}
