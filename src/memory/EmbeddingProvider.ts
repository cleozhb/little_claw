import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider (works with 百度 qianfan embedding-v1 etc.)
// ---------------------------------------------------------------------------

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  private maxInputTokens: number;
  private cache = new Map<string, number[]>();

  constructor(apiKey: string, model: string = "embedding-v1", baseURL?: string, maxInputTokens: number = 900) {
    this.model = model;
    this.maxInputTokens = Number.isFinite(maxInputTokens) && maxInputTokens > 0
      ? Math.floor(maxInputTokens)
      : 900;
    this.client = new OpenAI({
      apiKey,
      baseURL: baseURL ?? "https://qianfan.baidubce.com/v2",
    });
  }

  async embed(text: string): Promise<number[]> {
    // 粗略截断：embedding API 有单条 input token 上限（qianfan embedding-v1 为 1000）
    // 按 1 token ≈ 2 中文字符 / 4 英文字符 的保守估计截断
    const truncated = truncateForEmbedding(text, this.maxInputTokens);

    const key = await hashText(truncated);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const response = await this.client.embeddings.create({
      model: this.model,
      input: [truncated],
      encoding_format: "float",
    });

    const entry = response.data[0];
    if (!entry) throw new Error("Empty embedding response");
    this.cache.set(key, entry.embedding);
    return entry.embedding;
  }
}

// ---------------------------------------------------------------------------
// Local keyword-based fallback (no external API required)
//
// Produces a sparse bag-of-words vector by hashing each token into a
// fixed-size bucket array. Very rough, but gives non-zero cosine similarity
// for texts that share vocabulary — enough as a fallback.
// ---------------------------------------------------------------------------

const LOCAL_VECTOR_DIM = 256;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  private cache = new Map<string, number[]>();

  async embed(text: string): Promise<number[]> {
    const key = await hashText(text);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const vec = new Float64Array(LOCAL_VECTOR_DIM);

    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    for (const token of tokens) {
      // Simple string hash → bucket index
      let h = 0;
      for (let i = 0; i < token.length; i++) {
        h = (h * 31 + token.charCodeAt(i)) | 0;
      }
      const idx = ((h % LOCAL_VECTOR_DIM) + LOCAL_VECTOR_DIM) % LOCAL_VECTOR_DIM;
      vec[idx]! += 1;
    }

    // L2 normalise so cosine similarity works correctly
    let norm = 0;
    for (let i = 0; i < LOCAL_VECTOR_DIM; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < LOCAL_VECTOR_DIM; i++) vec[i]! /= norm;
    }

    const embedding = Array.from(vec);
    this.cache.set(key, embedding);
    return embedding;
  }
}

// ---------------------------------------------------------------------------
// Factory — auto-selects provider based on available config
// ---------------------------------------------------------------------------

export interface EmbeddingConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  maxInputChars?: number;
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  if (config.apiKey) {
    return new OpenAIEmbeddingProvider(
      config.apiKey,
      config.model,
      config.baseURL,
      config.maxInputChars,
    );
  }
  return new LocalEmbeddingProvider();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex hash of text, used as cache key. */
async function hashText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 截断文本以满足 embedding API 的输入上限。
 * qianfan embedding-v1 的错误信息按 input length 报 1000，因此这里用字符数
 * 做保守截断，而不是把 token 上限再换算成更长的字符数。
 */
export function truncateForEmbedding(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}
