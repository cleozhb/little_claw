import type { Tool, ToolResult } from "../types.ts";

const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 20;
const MAX_OUTPUT_LEN = 20_000;

type SearchDepth = "fast" | "basic" | "advanced";
type SearchTopic = "general" | "news" | "finance";

interface TavilySearchResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
  raw_content?: unknown;
  favicon?: unknown;
}

interface TavilySearchResponse {
  query?: unknown;
  answer?: unknown;
  results?: unknown;
  response_time?: unknown;
  usage?: unknown;
  request_id?: unknown;
}

export interface WebSearchToolOptions {
  apiKey?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export function createWebSearchTool(options: WebSearchToolOptions = {}): Tool {
  const endpoint = options.endpoint ?? TAVILY_SEARCH_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "web_search",
    description:
      "Search the web for current information using Tavily. Use this for recent or external information such as news, websites, podcasts, product pages, and RSS discovery leads.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The web search query." },
        max_results: {
          type: "number",
          description: "Maximum number of results to return. Default 5, max 20.",
        },
        search_depth: {
          type: "string",
          enum: ["fast", "basic", "advanced"],
          description: "Search depth. Default basic. Use advanced for high-precision research.",
        },
        topic: {
          type: "string",
          enum: ["general", "news", "finance"],
          description: "Search topic/category. Default general.",
        },
        include_answer: {
          type: "boolean",
          description: "Whether Tavily should include an answer summary. Default false.",
        },
        include_domains: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of domains to restrict results to.",
        },
        exclude_domains: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of domains to exclude.",
        },
      },
      required: ["query"],
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const apiKey = options.apiKey ?? process.env.TAVILY_API_KEY;
      if (!apiKey) {
        return {
          success: false,
          output: "",
          error: "TAVILY_API_KEY is not set.",
        };
      }

      const query = readString(params.query);
      if (!query) {
        return { success: false, output: "", error: "Missing required parameter: query" };
      }

      const payload = {
        query,
        max_results: readMaxResults(params.max_results),
        search_depth: readEnum<SearchDepth>(params.search_depth, ["fast", "basic", "advanced"], "basic"),
        topic: readEnum<SearchTopic>(params.topic, ["general", "news", "finance"], "general"),
        include_answer: readBoolean(params.include_answer, false),
        include_domains: readStringArray(params.include_domains),
        exclude_domains: readStringArray(params.exclude_domains),
      };

      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        });

        const text = await response.text();
        const data = parseJson(text);
        if (!response.ok) {
          return {
            success: false,
            output: text,
            error: formatTavilyError(response.status, data),
          };
        }

        return {
          success: true,
          output: truncate(JSON.stringify(normalizeTavilyResponse(data), null, 2)),
        };
      } catch (err) {
        return {
          success: false,
          output: "",
          error: `Tavily search request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

function normalizeTavilyResponse(data: unknown): Record<string, unknown> {
  const response = isRecord(data) ? data as TavilySearchResponse : {};
  const results = Array.isArray(response.results) ? response.results : [];
  return {
    query: typeof response.query === "string" ? response.query : undefined,
    answer: typeof response.answer === "string" ? response.answer : undefined,
    results: results.map(normalizeResult),
    response_time: response.response_time,
    usage: response.usage,
    request_id: response.request_id,
  };
}

function normalizeResult(value: unknown): Record<string, unknown> {
  const result = isRecord(value) ? value as TavilySearchResult : {};
  return {
    title: typeof result.title === "string" ? result.title : "",
    url: typeof result.url === "string" ? result.url : "",
    content: typeof result.content === "string" ? result.content : "",
    score: typeof result.score === "number" ? result.score : undefined,
    favicon: typeof result.favicon === "string" ? result.favicon : undefined,
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readMaxResults(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS_LIMIT, Math.floor(value)));
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== "string") return fallback;
  return allowed.includes(value as T) ? value as T : fallback;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return strings.length > 0 ? strings : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function formatTavilyError(status: number, data: unknown): string {
  if (isRecord(data)) {
    const detail = data.detail ?? data.error ?? data.message;
    if (typeof detail === "string") return `Tavily search failed (${status}): ${detail}`;
    if (detail !== undefined) return `Tavily search failed (${status}): ${JSON.stringify(detail)}`;
  }
  return `Tavily search failed with HTTP ${status}`;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_LEN) return text;
  return `${text.slice(0, MAX_OUTPUT_LEN)}\n... [truncated, ${text.length - MAX_OUTPUT_LEN} chars omitted]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
