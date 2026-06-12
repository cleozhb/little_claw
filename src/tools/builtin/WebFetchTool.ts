import type { Tool, ToolResult } from "../types.ts";
import type { LLMProvider } from "../../llm/types.ts";
import { truncateAtSentence, extractArticleContent, summarizeContent } from "./ContentProcessor.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

type FetchMode = "full" | "article" | "summary";
const DEFAULT_MAX_CHARS: Record<FetchMode, number> = { full: 20_000, article: 8_000, summary: 600 };

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]/,
  /^\[fe80:/i,
  /^\[fc/i,
  /^\[fd/i,
];

const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "[::1]"]);

export interface WebFetchToolOptions {
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  llmProvider?: LLMProvider;
}

export function createWebFetchTool(options: WebFetchToolOptions = {}): Tool {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "web_fetch",
    description:
      "Fetch the content of a specific URL and return it as plain text. Use this to read full articles, blog posts, or other web pages when you already have the URL. Only supports http/https.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch (http or https only)." },
        timeout_ms: {
          type: "number",
          description: "Request timeout in milliseconds. Default 15000, max 60000.",
        },
        mode: {
          type: "string",
          enum: ["full", "article", "summary"],
          description: "Processing mode. 'full': basic HTML stripping. 'article' (default): smart content extraction removing nav/sidebar/ads. 'summary': article extraction + LLM summarization.",
        },
        max_chars: {
          type: "number",
          description: "Maximum output characters. Defaults: full=20000, article=8000, summary=600.",
        },
      },
      required: ["url"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const rawUrl = typeof params.url === "string" ? params.url.trim() : "";
      if (!rawUrl) {
        return { success: false, output: "", error: "Missing required parameter: url" };
      }

      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return { success: false, output: "", error: `Invalid URL: ${rawUrl}` };
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { success: false, output: "", error: `Only http/https URLs are allowed. Got: ${parsed.protocol}` };
      }

      if (isBlockedHost(parsed.hostname)) {
        return { success: false, output: "", error: "Access to private/local network addresses is blocked." };
      }

      const mode = readEnum(params.mode, ["full", "article", "summary"] as const, "article");
      const maxChars = readMaxChars(params.max_chars, DEFAULT_MAX_CHARS[mode]);
      const timeoutMs = readTimeout(params.timeout_ms);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetchImpl(rawUrl, {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; LittleClaw/1.0; +https://github.com/littleclaw)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          signal: controller.signal,
          redirect: "follow",
        });

        clearTimeout(timer);

        if (!response.ok) {
          return {
            success: false,
            output: "",
            error: `HTTP ${response.status} ${response.statusText} for ${rawUrl}`,
          };
        }

        const contentType = response.headers.get("content-type") ?? "unknown";
        const body = await response.text();

        let content: string;
        let title = "";
        let wordCount = 0;

        if (isHtml(contentType)) {
          if (mode === "full") {
            content = htmlToText(body);
          } else {
            const extracted = extractArticleContent(body);
            title = extracted.title;
            wordCount = extracted.wordCount;
            content = extracted.content;
          }
        } else {
          content = body;
          wordCount = body.split(/\s+/).filter(Boolean).length;
        }

        if (mode === "summary" && options.llmProvider && content.length > 200) {
          content = await summarizeContent(content, options.llmProvider, { maxOutputChars: maxChars });
        } else {
          const truncated = truncateAtSentence(content, maxChars);
          content = truncated.text;
        }

        return {
          success: true,
          output: JSON.stringify({
            url: rawUrl,
            final_url: response.url,
            title: title || undefined,
            word_count: wordCount,
            content_length: content.length,
            mode,
            content,
          }, null, 2),
        };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return { success: false, output: "", error: `Request timed out after ${timeoutMs}ms` };
        }
        return {
          success: false,
          output: "",
          error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

function isBlockedHost(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) return true;
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) return true;
  }
  return false;
}

function isHtml(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/html") || contentType.toLowerCase().includes("application/xhtml");
}

function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/?(p|div|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&[#\w]+;/g, "");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function readTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

function readMaxChars(value: unknown, defaultValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
  return Math.max(100, Math.min(50_000, Math.floor(value)));
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== "string") return fallback;
  return allowed.includes(value as T) ? value as T : fallback;
}
