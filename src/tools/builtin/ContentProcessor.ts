import type { LLMProvider } from "../../llm/types.ts";
import type { Message } from "../../types/message.ts";

/**
 * Truncate text at the nearest sentence boundary before maxChars.
 */
export function truncateAtSentence(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };

  const searchStart = Math.floor(maxChars * 0.8);
  const slice = text.slice(0, maxChars);

  const sentenceEnd = /[.!?。！？](?:\s|$)/g;
  let lastMatch = -1;
  sentenceEnd.lastIndex = searchStart;
  let m: RegExpExecArray | null;
  while ((m = sentenceEnd.exec(slice)) !== null) {
    lastMatch = m.index + 1;
  }

  if (lastMatch > searchStart && lastMatch <= maxChars) {
    return { text: text.slice(0, lastMatch).trimEnd(), truncated: true };
  }

  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > searchStart) {
    return { text: text.slice(0, lastSpace).trimEnd(), truncated: true };
  }

  return { text: slice, truncated: true };
}

export function extractArticleContent(html: string): { title: string; content: string; wordCount: number } {
  let title = "";
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = decodeEntities(titleMatch[1]!.trim());

  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  let body = html;
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const roleMainMatch = html.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/i);

  if (articleMatch) body = articleMatch[1]!;
  else if (mainMatch) body = mainMatch[1]!;
  else if (roleMainMatch) body = roleMainMatch[1]!;

  body = body.replace(/<(nav|aside|footer|header)[\s\S]*?<\/\1>/gi, "");
  body = body.replace(/<[^>]+(class|id)=["'][^"']*\b(nav|sidebar|footer|menu|comment|share|social|ad|advertisement|related|recommend|newsletter|popup|modal|cookie|banner|promo)\b[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, "");

  body = body.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, _href, text) => {
    return text.replace(/<[^>]+>/g, "").trim();
  });

  body = body.replace(/<br\s*\/?>/gi, "\n");
  body = body.replace(/<\/?(p|div|h[1-6]|li|tr|blockquote|section|article|ul|ol)[^>]*>/gi, "\n");
  body = body.replace(/<[^>]+>/g, "");
  body = decodeEntities(body);
  body = body.replace(/[ \t]+/g, " ");
  body = body.replace(/ ?\n ?/g, "\n");
  body = body.replace(/\n{3,}/g, "\n\n");
  body = removeNoiseKeywords(body);
  body = collapseNoiseLines(body);
  body = body.trim();

  const wordCount = body.split(/\s+/).filter(Boolean).length;
  return { title, content: body, wordCount };
}

export async function summarizeContent(
  content: string,
  llmProvider: LLMProvider,
  options?: { maxOutputChars?: number; context?: string },
): Promise<string> {
  const maxOutput = options?.maxOutputChars ?? 600;
  const input = content.slice(0, 12_000);
  const system = `简洁总结以下内容，保留关键事实、数字、人名、URL。输出不超过${maxOutput}字符。${options?.context ? `\n上下文: ${options.context}` : ""}`;

  const messages: Message[] = [{ role: "user", content: input }];
  try {
    let result = "";
    for await (const event of llmProvider.chat(messages, { system })) {
      if (event.type === "text_delta") result += event.text;
    }
    return result.trim();
  } catch {
    return truncateAtSentence(content, maxOutput).text;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[#\w]+;/g, "");
}

const NOISE_LINE_KEYWORDS = /^(Share|Subscribe|Email|Facebook|LinkedIn|Twitter|Reddit|WhatsApp|Flipboard|Hacker News|Posted|new|X|More From These Contributors|Recommended For You|Learn More|View Bio|REGISTER NOW|Most Popular|Want More|About the Contributors)$/i;

function removeNoiseKeywords(text: string): string {
  return text.split("\n").filter(line => !NOISE_LINE_KEYWORDS.test(line.trim())).join("\n");
}

function collapseNoiseLines(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let consecutiveShort = 0;
  const shortBuf: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (consecutiveShort >= 3) {
        shortBuf.length = 0;
      } else {
        result.push(...shortBuf);
      }
      consecutiveShort = 0;
      shortBuf.length = 0;
      result.push("");
    } else if (trimmed.length <= 15 && !/[.!?。！？:]/.test(trimmed)) {
      consecutiveShort++;
      shortBuf.push(trimmed);
    } else {
      if (consecutiveShort >= 3) {
        shortBuf.length = 0;
      } else {
        result.push(...shortBuf);
      }
      consecutiveShort = 0;
      shortBuf.length = 0;
      result.push(trimmed);
    }
  }

  if (consecutiveShort < 3) result.push(...shortBuf);

  return result.join("\n").replace(/\n{3,}/g, "\n\n");
}
