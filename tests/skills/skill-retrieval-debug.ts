/**
 * Skill 检索调试脚本 — 对比旧逻辑 vs A+B+D 新逻辑
 *
 * 用法: bun tests/skills/skill-retrieval-debug.ts [query1] [query2] ...
 *
 * 环境变量:
 *   EMBEDDING_API_KEY (或 LLM_API_KEY)
 *   RERANK_API_KEY (或 LLM_API_KEY)
 *   RERANK_MODEL (默认 bge-reranker-v2-m3)
 *   RERANK_BASE_URL (默认 https://qianfan.baidubce.com/v2/rerank)
 */

import { createEmbeddingProvider } from "../../src/memory/EmbeddingProvider";
import { SkillRetriever } from "../../src/skills/SkillRetriever";
import { SkillIndexer } from "../../src/skills/SkillIndexer";
import { SkillLoader } from "../../src/skills/SkillLoader";
import { Database } from "../../src/db/Database";
import { join } from "path";
import type { ParsedSkill, ScoredSkill } from "../../src/skills/types";
import { unlinkSync } from "fs";

// ─── 配置 ───────────────────────────────────────────────────────────────────

const OLD_MIN_SCORE = 0.25;
const OLD_MIN_VECTOR = 0.35;

const NEW_MIN_VECTOR = 0.5;       // 方案 A: 提高向量阈值
const NEW_MIN_GAP = 0.05;         // 方案 B: top1 与 top2 的 vectorScore 差值要求
const RERANK_THRESHOLD = 0.5;     // 方案 D: rerank 分数阈值

// ─── 测试 queries ────────────────────────────────────────────────────────────

const queries = process.argv.slice(2);
if (queries.length === 0) {
  queries.push(
    "帮我执行 curl www.baidu.com",
    "帮我翻译这期播客",
    "say hello in Japanese",
    "我的IP地址是什么",
    "帮我写一个React组件",
    "张一鸣怎么看这个问题",
  );
}

// ─── 初始化 ──────────────────────────────────────────────────────────────────

const apiKey = process.env.EMBEDDING_API_KEY ?? process.env.LLM_API_KEY;
if (!apiKey) {
  console.error("需要设置 EMBEDDING_API_KEY 或 LLM_API_KEY");
  process.exit(1);
}

const embedding = createEmbeddingProvider({
  apiKey,
  model: process.env.EMBEDDING_MODEL ?? "qwen3-embedding-8b",
  baseURL: process.env.EMBEDDING_BASE_URL ?? "https://qianfan.baidubce.com/v2",
});

const rerankApiKey = process.env.RERANK_API_KEY ?? apiKey;
const rerankBaseURL = process.env.RERANK_BASE_URL ?? "https://qianfan.baidubce.com/v2/rerank";
const rerankModel = "qwen3-reranker-8b"; // 强制使用，.env 中的 bge-reranker-v2-m3 在千帆不可用

const tmpDb = join(import.meta.dir, ".skill-debug-tmp.db");
const db = new Database(tmpDb);

const loader = new SkillLoader();
const loaded = await loader.loadAll();
const skillMap = new Map<string, ParsedSkill>();
for (const { parsed } of loaded) {
  skillMap.set(parsed.name, parsed);
}

console.log(`已加载 ${skillMap.size} 个 skills: ${[...skillMap.keys()].join(", ")}\n`);

const indexer = new SkillIndexer(db, embedding);
await indexer.indexAll([...skillMap.values()]);
const retriever = new SkillRetriever(db, embedding, () => skillMap);

// ─── Rerank 调用 ─────────────────────────────────────────────────────────────

async function rerank(query: string, candidates: ScoredSkill[]): Promise<{ skill: ScoredSkill; rerankScore: number }[]> {
  if (candidates.length === 0) return [];
  const documents = candidates.map(c =>
    `${c.skill.name}: ${c.skill.description}\n${c.skill.instructions.slice(0, 500)}`
  );

  const response = await fetch(rerankBaseURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${rerankApiKey}`,
    },
    body: JSON.stringify({ model: rerankModel, query, documents, top_n: candidates.length }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Rerank API error ${response.status}: ${text}`);
  }
  const data = await response.json() as { results: { index: number; relevance_score: number }[] };

  return data.results
    .map(r => ({ skill: candidates[r.index]!, rerankScore: r.relevance_score }))
    .sort((a, b) => b.rerankScore - a.rerankScore);
}

// ─── 过滤逻辑 ────────────────────────────────────────────────────────────────

function oldFilter(results: ScoredSkill[]): ScoredSkill[] {
  return results.filter(r =>
    r.score >= OLD_MIN_SCORE && (r.bm25Score > 0 || r.vectorScore >= OLD_MIN_VECTOR)
  );
}

function newFilterAB(results: ScoredSkill[]): ScoredSkill[] {
  // A: 提高向量阈值
  const passed = results.filter(r =>
    r.bm25Score > 0 || r.vectorScore >= NEW_MIN_VECTOR
  );
  if (passed.length === 0) return [];

  // B: gap 判断（仅当 BM25 全为 0 时）
  const hasBM25 = passed.some(r => r.bm25Score > 0);
  if (!hasBM25 && passed.length >= 2) {
    const gap = passed[0]!.vectorScore - passed[1]!.vectorScore;
    if (gap < NEW_MIN_GAP) return [];
  }

  return passed;
}

// ─── 主循环 ──────────────────────────────────────────────────────────────────

for (const query of queries) {
  const results = await retriever.retrieve(query, skillMap.size);

  console.log(`\n${"═".repeat(74)}`);
  console.log(`查询: "${query}"`);
  console.log(`${"─".repeat(74)}`);

  // 旧逻辑
  const oldPassed = oldFilter(results);
  const oldSelected = oldPassed[0];
  console.log(`[旧逻辑] 选中: ${oldSelected ? `${oldSelected.skill.name} (vector=${oldSelected.vectorScore.toFixed(2)})` : "无"}`);

  // A+B
  const abPassed = newFilterAB(results);
  console.log(`[A+B]    通过: ${abPassed.length > 0 ? abPassed.map(r => `${r.skill.name}(${r.vectorScore.toFixed(2)})`).join(", ") : "无"}`);

  // D: rerank（所有通过 A+B 的候选都走 rerank）
  if (abPassed.length > 0) {
    const top3 = abPassed.slice(0, 3);
    const reranked = await rerank(query, top3);
    const accepted = reranked.filter(r => r.rerankScore >= RERANK_THRESHOLD);
    if (accepted.length > 0) {
      console.log(`[A+B+D]  最终: ${accepted[0]!.skill.skill.name} (rerank=${accepted[0]!.rerankScore.toFixed(4)})`);
      if (accepted.length > 1) {
        console.log(`         其他: ${accepted.slice(1).map(r => `${r.skill.skill.name}(${r.rerankScore.toFixed(4)})`).join(", ")}`);
      }
    } else {
      console.log(`[A+B+D]  最终: 无 (rerank 分数均 < ${RERANK_THRESHOLD})`);
      console.log(`         详情: ${reranked.map(r => `${r.skill.skill.name}(${r.rerankScore.toFixed(4)})`).join(", ")}`);
    }
  } else {
    console.log(`[A+B+D]  最终: 无 (A+B 阶段已过滤)`);
  }
}

console.log(`\n${"═".repeat(74)}`);
console.log(`参数: NEW_MIN_VECTOR=${NEW_MIN_VECTOR}, NEW_MIN_GAP=${NEW_MIN_GAP}, RERANK_THRESHOLD=${RERANK_THRESHOLD}`);
console.log();

try { unlinkSync(tmpDb); } catch {}
try { unlinkSync(`${tmpDb}-shm`); } catch {}
try { unlinkSync(`${tmpDb}-wal`); } catch {}
