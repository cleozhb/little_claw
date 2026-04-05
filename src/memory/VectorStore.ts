import { Database as SQLiteDatabase } from "bun:sqlite";
import type { EmbeddingProvider } from "./EmbeddingProvider.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  content: string;
  sessionId: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

interface EmbeddingRow {
  id: string;
  session_id: string;
  content: string;
  embedding: string;
  created_at: string;
  metadata: string;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// VectorStore
// ---------------------------------------------------------------------------

export class VectorStore {
  private db: SQLiteDatabase;
  private embeddingProvider: EmbeddingProvider;

  // Prepared statements
  private stmtInsert;
  private stmtGetAll;
  private stmtDeleteBySession;
  private stmtCount;
  private stmtCountBySession;
  private stmtDeleteAll;

  constructor(dbPath: string, embeddingProvider: EmbeddingProvider) {
    this.db = new SQLiteDatabase(dbPath);
    this.embeddingProvider = embeddingProvider;

    this.db.run("PRAGMA journal_mode = WAL");

    this.initTable();

    this.stmtInsert = this.db.prepare(
      `INSERT INTO memory_embeddings (id, session_id, content, embedding, created_at, metadata)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    );

    this.stmtGetAll = this.db.prepare(
      `SELECT * FROM memory_embeddings`,
    );

    this.stmtDeleteBySession = this.db.prepare(
      `DELETE FROM memory_embeddings WHERE session_id = ?1`,
    );

    this.stmtCount = this.db.prepare(
      `SELECT COUNT(*) as count FROM memory_embeddings`,
    );

    this.stmtCountBySession = this.db.prepare(
      `SELECT session_id, COUNT(*) as count FROM memory_embeddings GROUP BY session_id`,
    );

    this.stmtDeleteAll = this.db.prepare(
      `DELETE FROM memory_embeddings`,
    );

    // 启动时检查 embedding 维度一致性：
    // 如果现有记录的维度与当前 provider 不同，清理旧数据（避免 cosine 计算全 0）
    this.validateEmbeddingDimension();
  }

  /**
   * 校验已存储 embedding 的维度是否与当前 provider 一致。
   * 维度不匹配或全零向量（无效 embedding）时自动清除。
   */
  private validateEmbeddingDimension(): void {
    const row = this.db.prepare(
      `SELECT embedding FROM memory_embeddings LIMIT 1`,
    ).get() as { embedding: string } | null;
    if (!row) return;

    const stored: number[] = JSON.parse(row.embedding);
    // 全零向量也视为无效（API 返回错误数据）
    const allZero = stored.every((v) => v === 0);
    if (allZero) {
      const count = this.getCount();
      this.stmtDeleteAll.run();
      console.log(
        `[memory] Cleared ${count} entries with invalid (all-zero) embeddings`,
      );
    }
  }

  private initTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        content     TEXT NOT NULL,
        embedding   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        metadata    TEXT NOT NULL DEFAULT '{}'
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_session
        ON memory_embeddings (session_id)
    `);
  }

  // --- Public API ---

  async store(
    sessionId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const embedding = await this.embeddingProvider.embed(content);

    this.stmtInsert.run(
      crypto.randomUUID(),
      sessionId,
      content,
      JSON.stringify(embedding),
      new Date().toISOString(),
      JSON.stringify(metadata ?? {}),
    );
  }

  async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    const queryEmbedding = await this.embeddingProvider.embed(query);
    const rows = this.stmtGetAll.all() as EmbeddingRow[];

    const scored = rows.map((row) => {
      const embedding: number[] = JSON.parse(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      return {
        content: row.content,
        sessionId: row.session_id,
        similarity,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      };
    });

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  deleteBySession(sessionId: string): void {
    this.stmtDeleteBySession.run(sessionId);
  }

  deleteAll(): void {
    this.stmtDeleteAll.run();
  }

  /** 总记忆条数 */
  getCount(): number {
    const row = this.stmtCount.get() as { count: number };
    return row.count;
  }

  /** 按 session 分组的统计 */
  getCountBySession(): Array<{ sessionId: string; count: number }> {
    const rows = this.stmtCountBySession.all() as Array<{ session_id: string; count: number }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      count: r.count,
    }));
  }

  // --- Lifecycle ---

  close(): void {
    this.db.close();
  }
}
