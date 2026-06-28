import { expect, test } from "bun:test";
import { computeBM25 } from "../../src/retrieval/bm25.ts";
import { retrieveHybrid } from "../../src/retrieval/HybridRetriever.ts";
import { tokenize } from "../../src/retrieval/tokenizer.ts";
import { cosineSimilarity } from "../../src/retrieval/vector.ts";

test("tokenizer keeps code-aware, short acronym, version, and CJK tokens", () => {
  const tokens = tokenize(
    "AI DB v2 API_KEY read_content_ref ToolResultBlock src/memory/ContextRetriever.ts foo.bar() 中文检索",
  );
  const tokenSet = new Set(tokens);

  expect(tokenSet.has("ai")).toBe(true);
  expect(tokenSet.has("db")).toBe(true);
  expect(tokenSet.has("v2")).toBe(true);
  expect(tokenSet.has("api_key")).toBe(true);
  expect(tokenSet.has("read_content_ref")).toBe(true);
  expect(tokenSet.has("read")).toBe(true);
  expect(tokenSet.has("content")).toBe(true);
  expect(tokenSet.has("ref")).toBe(true);
  expect(tokenSet.has("toolresultblock")).toBe(true);
  expect(tokenSet.has("contextretriever")).toBe(true);
  expect(tokens.some((token) => token.includes("中文") || token.includes("检索"))).toBe(true);
});

test("BM25 ranks exact keyword matches higher", () => {
  const scores = computeBM25(tokenize("robotics valuation"), [
    { id: "match", tokens: tokenize("robotics company raised at valuation") },
    { id: "miss", tokens: tokenize("recipe notes for lunch") },
  ]);

  expect(scores.get("match") ?? 0).toBeGreaterThan(scores.get("miss") ?? 0);
});

test("hybrid retrieval fuses BM25 and vector scores", () => {
  const results = retrieveHybrid({
    queryTokens: tokenize("robotics funding"),
    queryEmbedding: [1, 0],
    documents: [
      { id: "keyword", tokens: tokenize("robotics funding"), embedding: [0, 1] },
      { id: "vector", tokens: tokenize("unrelated notes"), embedding: [1, 0] },
    ],
    topK: 2,
  });

  expect(results).toHaveLength(2);
  expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
});

