import type { Database, MemoryIndexRow } from "../db/Database.ts";
import type { EmbeddingProvider } from "./EmbeddingProvider.ts";
import { tokenize } from "../retrieval/tokenizer.ts";
import { computeBM25, matchedTokens } from "../retrieval/bm25.ts";
import { cosineSimilarity, parseEmbedding } from "../retrieval/vector.ts";
import type { MemorySourceKind } from "./MemoryStore.ts";

export interface ScoredMemory {
  content: string;
  sourcePath: string;
  sourceKind: string;
  chunkIndex: number;
  score: number;
  bm25Score: number;
  vectorScore: number;
  matchReason: string;
  updatedAt: string;
  embeddingStatus: "ready" | "missing";
}

export interface MemoryRetrieveOptions {
  topK?: number;
  maxPerSource?: number;
  allowedKinds?: MemorySourceKind[];
  excludeSourcePaths?: string[];
  minimumVectorScore?: number;
}

const KIND_WEIGHTS: Record<string, number> = {
  memory: 1.4,
  inbox: 0.8,
  daily: 1.0,
};

export class MemoryRetriever {
  constructor(
    private db: Database,
    private embedding: EmbeddingProvider,
  ) {}

  async retrieve(query: string, options: number | MemoryRetrieveOptions = 5): Promise<ScoredMemory[]> {
    const resolved = typeof options === "number" ? { topK: options } : options;
    const topK = resolved.topK ?? 5;
    const allowedKinds = resolved.allowedKinds ? new Set(resolved.allowedKinds) : null;
    const excluded = new Set(resolved.excludeSourcePaths ?? []);
    const rows = this.db.getAllMemoryIndex().filter((row) =>
      (!allowedKinds || allowedKinds.has(row.source_kind)) && !excluded.has(row.source_path)
    );
    if (rows.length === 0) return [];

    const queryTokens = tokenize(query);
    const queryEmbedding = await this.embedQuerySafely(query);
    const signature = this.embedding.getSignature?.() ?? "unknown";
    const documents = rows.map((row) => ({
      id: row.id,
      tokens: row.keywords.split(/\s+/).filter(Boolean),
    }));
    const bm25 = computeBM25(queryTokens, documents);
    const bm25Ranking = [...rows]
      .filter((row) => (bm25.get(row.id) ?? 0) > 0)
      .sort((a, b) => (bm25.get(b.id) ?? 0) - (bm25.get(a.id) ?? 0));
    const maxBM25 = Math.max(0, ...bm25.values());
    const vectorScores = new Map<string, number>();
    if (queryEmbedding?.length) {
      for (const row of rows) {
        if (
          row.embedding_status !== "ready" || row.embedding_signature !== signature ||
          row.embedding_dimensions !== queryEmbedding.length
        ) continue;
        const score = cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding));
        vectorScores.set(row.id, score);
      }
    }
    const minimumVectorScore = resolved.minimumVectorScore ?? 0.4;
    const vectorRanking = [...rows]
      .filter((row) => (vectorScores.get(row.id) ?? -1) >= minimumVectorScore)
      .sort((a, b) => (vectorScores.get(b.id) ?? 0) - (vectorScores.get(a.id) ?? 0));
    const fused = reciprocalRankFusion(bm25Ranking.map((row) => row.id), vectorRanking.map((row) => row.id));

    const rowById = new Map(rows.map((row) => [row.id, row]));
    const results: ScoredMemory[] = [];
    for (const [id, fusedScore] of [...fused.entries()].sort((a, b) => b[1] - a[1])) {
      const row = rowById.get(id);
      if (!row) continue;

      const rawBm25 = bm25.get(id) ?? 0;
      const bm25Score = maxBM25 > 0 ? rawBm25 / maxBM25 : 0;
      const vectorScore = vectorScores.get(id) ?? 0;
      const score = fusedScore * (KIND_WEIGHTS[row.source_kind] ?? 1.0);

      const reasons: string[] = [];
      if (rawBm25 > 0) {
        reasons.push(`keyword: ${matchedTokens(queryTokens, row.keywords).join(", ")}`);
      }
      if (vectorScore >= minimumVectorScore) {
        reasons.push(`vector: ${vectorScore.toFixed(2)}`);
      }
      if ((KIND_WEIGHTS[row.source_kind] ?? 1.0) !== 1.0) {
        reasons.push(`kind: ${row.source_kind}`);
      }

      results.push({
        content: row.content,
        sourcePath: row.source_path,
        sourceKind: row.source_kind,
        chunkIndex: row.chunk_index,
        score,
        bm25Score,
        vectorScore,
        matchReason: reasons.join(" | ") || "low relevance",
        updatedAt: row.updated_at,
        embeddingStatus: row.embedding_status,
      });
    }

    results.sort((a, b) => b.score - a.score);
    if (resolved.maxPerSource) {
      const counts = new Map<string, number>();
      return results.filter((result) => {
        const count = counts.get(result.sourcePath) ?? 0;
        if (count >= resolved.maxPerSource!) return false;
        counts.set(result.sourcePath, count + 1);
        return true;
      }).slice(0, topK);
    }
    return results.slice(0, topK);
  }

  private async embedQuerySafely(query: string): Promise<number[] | undefined> {
    try {
      return await this.embedding.embed(query);
    } catch {
      return undefined;
    }
  }
}

function reciprocalRankFusion(...rankings: string[][]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1));
    });
  }
  return scores;
}
