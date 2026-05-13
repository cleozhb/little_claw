import { expect, test } from "bun:test";
import {
  DEFAULT_EMBEDDING_BASE_URL,
  DEFAULT_EMBEDDING_MODEL,
  OpenAIEmbeddingProvider,
  truncateForEmbedding,
} from "../../src/memory/EmbeddingProvider";

test("truncateForEmbedding caps text by character length", () => {
  const text = "中".repeat(1200);
  const truncated = truncateForEmbedding(text, 900);

  expect(truncated.length).toBe(900);
});

test("truncateForEmbedding keeps shorter text unchanged", () => {
  const text = "short overview";

  expect(truncateForEmbedding(text, 900)).toBe(text);
});

test("OpenAIEmbeddingProvider defaults to qianfan qwen3 embedding", () => {
  const provider = new OpenAIEmbeddingProvider("test-key") as unknown as {
    model: string;
    client: { baseURL: string };
    getSignature(): string;
  };

  expect(provider.model).toBe(DEFAULT_EMBEDDING_MODEL);
  expect(provider.client.baseURL).toBe(DEFAULT_EMBEDDING_BASE_URL);
  expect(provider.getSignature()).toContain(DEFAULT_EMBEDDING_MODEL);
});

test("OpenAIEmbeddingProvider sends qianfan-compatible string input", async () => {
  const provider = new OpenAIEmbeddingProvider("test-key") as unknown as {
    client: { embeddings: { create: (params: unknown) => Promise<{ data: Array<{ embedding: number[] }> }> } };
    embed(text: string): Promise<number[]>;
  };
  let captured: unknown;
  provider.client.embeddings.create = async (params: unknown) => {
    captured = params;
    return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
  };

  const embedding = await provider.embed("hello");

  expect(embedding).toEqual([0.1, 0.2, 0.3]);
  expect(captured).toMatchObject({
    model: DEFAULT_EMBEDDING_MODEL,
    input: "hello",
  });
});
