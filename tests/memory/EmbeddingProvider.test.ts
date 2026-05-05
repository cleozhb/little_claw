import { expect, test } from "bun:test";
import { truncateForEmbedding } from "../../src/memory/EmbeddingProvider";

test("truncateForEmbedding caps text by character length", () => {
  const text = "中".repeat(1200);
  const truncated = truncateForEmbedding(text, 900);

  expect(truncated.length).toBe(900);
});

test("truncateForEmbedding keeps shorter text unchanged", () => {
  const text = "short overview";

  expect(truncateForEmbedding(text, 900)).toBe(text);
});
