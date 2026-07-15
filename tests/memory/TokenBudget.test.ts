import { expect, test } from "bun:test";
import { estimateTokens, limitStringsToTokenBudget, truncateToTokenBudget } from "../../src/memory/TokenBudget.ts";

test("memory truncation including its marker stays within the hard token budget", () => {
  const truncated = truncateToTokenBudget("长期记忆".repeat(2_000), 100);
  expect(estimateTokens(truncated)).toBeLessThanOrEqual(100);
  expect(truncated).toContain("Memory truncated");
});

test("retrieved memory list stays within its aggregate token budget", () => {
  const values = limitStringsToTokenBudget(["a".repeat(300), "b".repeat(300)], 100);
  expect(estimateTokens(values.join(""))).toBeLessThanOrEqual(100);
});
