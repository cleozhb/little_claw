const STOP_WORDS = new Set([
  "the", "and", "for", "this", "that", "with", "from", "are", "was",
  "were", "will", "have", "has", "had", "not", "but", "can", "use",
  "when", "how", "what", "which", "their", "there", "about", "into",
  "than", "them", "then", "some", "other", "should", "would", "could",
  "may", "might", "you", "your", "its", "all", "any", "each", "every",
  "both", "few", "more", "most", "such", "only", "own", "same", "too",
  "very", "just", "also", "now", "here", "http", "https", "www",
]);

const CODE_TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*(?:[._/-][A-Za-z0-9_$]+)+|(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z_$][A-Za-z0-9_$]*\(\)?/g;
const WORD_RE = /[A-Za-z0-9]+/g;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;

export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC");
  const tokens: string[] = [];

  for (const match of normalized.matchAll(CODE_TOKEN_RE)) {
    addCodeTokens(tokens, match[0]);
  }

  for (const match of normalized.matchAll(WORD_RE)) {
    addWordToken(tokens, match[0]);
    for (const part of splitIdentifier(match[0])) {
      addWordToken(tokens, part);
    }
  }

  for (const match of normalized.matchAll(CJK_RE)) {
    addCjkTokens(tokens, match[0]);
  }

  return tokens.filter(Boolean);
}

export function tokenizeUnique(text: string): string[] {
  return [...new Set(tokenize(text))];
}

function addCodeTokens(tokens: string[], raw: string): void {
  const cleaned = raw.replace(/\(\)$/, "");
  const canonical = normalizeToken(cleaned);
  if (canonical.length >= 2) tokens.push(canonical);

  for (const segment of cleaned.split(/[._/-]+/)) {
    addWordToken(tokens, segment);
    for (const part of splitIdentifier(segment)) {
      addWordToken(tokens, part);
    }
  }
}

function addWordToken(tokens: string[], raw: string): void {
  const token = normalizeToken(raw);
  if (!token || STOP_WORDS.has(token)) return;

  const isShortUseful =
    /^[a-z]{2}$/.test(token) && /^[A-Z]{2}$/.test(raw) ||
    /^[a-z]+\d+[a-z0-9]*$/.test(token) ||
    /^v\d+(?:\.\d+)*$/.test(token) ||
    /^\d+$/.test(token);

  if (token.length >= 3 || isShortUseful) {
    tokens.push(token);
  }
}

function addCjkTokens(tokens: string[], text: string): void {
  const segmented = segmentCjk(text);
  if (segmented.length > 0) {
    tokens.push(...segmented);
    return;
  }

  const chars = [...text];
  if (chars.length <= 1) return;
  if (chars.length <= 8) tokens.push(chars.join(""));
  for (const size of [2, 3]) {
    for (let i = 0; i <= chars.length - size; i++) {
      tokens.push(chars.slice(i, i + size).join(""));
    }
  }
}

function segmentCjk(text: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (!Segmenter) return [];

  try {
    const segmenter = new Segmenter("zh", { granularity: "word" });
    const tokens: string[] = [];
    for (const segment of segmenter.segment(text)) {
      if (!segment.isWordLike) continue;
      const token = normalizeToken(segment.segment);
      if (token.length >= 2) tokens.push(token);
    }
    return tokens;
  } catch {
    return [];
  }
}

function splitIdentifier(raw: string): string[] {
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function normalizeToken(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}_./-]+|[^\p{L}\p{N}_./-]+$/gu, "");
}

