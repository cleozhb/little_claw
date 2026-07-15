/**
 * src/memory/ContextIndexer.ts — Context Hub .overview.md 索引构建器
 *
 * 扫描 context-hub/ 下的 .overview.md 文件，提取关键词、生成 embedding，
 * 写入 context_index 表。支持变更检测（内容 hash 不变则跳过）。
 *
 * 跳过废弃的 0-identity/ 和 1-inbox/（新系统不再创建或索引）。
 */

import type { Database, ContextIndexRow } from "../db/Database.ts";
import type { EmbeddingProvider } from "./EmbeddingProvider.ts";
import type { ContextHub } from "./ContextHub.ts";
import { tokenize } from "../skills/tokenize.ts";

/** 不参与检索的废弃目录前缀 */
const SKIP_PREFIXES = ["0-identity", "1-inbox"];

export class ContextIndexer {
  private mutationTail: Promise<void> = Promise.resolve();
  private providerFailureHandler?: () => void;
  constructor(
    private db: Database,
    private embedding: EmbeddingProvider,
    private contextHub: ContextHub,
  ) {}

  /**
   * 对所有 .overview.md 建立索引（跳过未变化的）。
   */
  indexAll(): Promise<ContextIndexRunResult> {
    return this.observe(this.enqueue(() => this.indexAllInner()));
  }

  rebuildAll(): Promise<ContextIndexRunResult> {
    return this.observe(this.enqueue(() => this.rebuildAllInner()));
  }

  reindexDir(dirPath: string): Promise<ContextIndexRunResult> {
    return this.observe(this.enqueue(() => this.reindexDirInner(dirPath)));
  }

  onProviderFailure(handler: () => void): void {
    this.providerFailureHandler = handler;
  }

  async drain(): Promise<void> {
    await this.mutationTail;
  }

  private async indexAllInner(): Promise<ContextIndexRunResult> {
    const existing = new Map<string, ContextIndexRow>();
    for (const row of this.db.getAllContextIndex()) {
      existing.set(row.dir_path, row);
    }

    // 扫描 context-hub 下所有目录
    const dirs = await this.contextHub.listDirectories();
    const indexedPaths = new Set<string>();
    let indexed = 0;
    let skipped = 0;
    let missingEmbeddings = 0;
    let providerFailed = false;

    for (const dir of dirs) {
      // dir 格式为 "context-hub/2-areas" 或 "context-hub/2-areas/content"
      const relativePath = dir.startsWith("context-hub/")
        ? dir.slice("context-hub/".length)
        : dir;

      // 跳过不参与检索的目录
      if (SKIP_PREFIXES.some((p) => relativePath.startsWith(p))) continue;

      // 读取 .overview.md
      const overview = await this.contextHub.readOverview(relativePath);
      if (!overview) continue;

      indexedPaths.add(relativePath);
      const old = existing.get(relativePath);
      const contentHash = this.indexHash(overview);
      const signature = this.embedding.getSignature?.() ?? "unknown";

      // 变更检测
      if (
        old && old.content_hash === contentHash && old.embedding_signature === signature &&
        old.embedding_status === "ready"
      ) {
        skipped++;
        continue;
      }

      const result = await this.indexOne(relativePath, overview, contentHash, old);
      indexed += result.indexed;
      skipped += result.skipped;
      missingEmbeddings += result.missingEmbeddings;
      providerFailed ||= result.providerFailed;
    }
    // 删除已不存在的索引
    for (const dirPath of existing.keys()) {
      if (!indexedPaths.has(dirPath)) {
        this.db.deleteContextIndex(dirPath);
      }
    }
    return { indexed, skipped, missingEmbeddings, providerFailed };
  }

  /**
   * 对单个目录的 .overview.md 建立索引。
   */
  private async indexOne(
    dirPath: string,
    overviewContent: string,
    contentHash?: string,
    old?: ContextIndexRow,
  ): Promise<ContextIndexRunResult> {
    const hash = contentHash ?? this.indexHash(overviewContent);
    const keywords = extractKeywords(dirPath, overviewContent);
    let embeddingVec: number[] = [];
    let providerFailed = false;
    try {
      embeddingVec = await this.embedding.embed(overviewContent);
      if (embeddingVec.length === 0) providerFailed = true;
    } catch {
      providerFailed = true;
    }

    if (providerFailed && old?.content_hash === hash) {
      return {
        indexed: 0,
        skipped: 1,
        missingEmbeddings: old.embedding_status === "ready" ? 0 : 1,
        providerFailed: true,
      };
    }

    const signature = this.embedding.getSignature?.() ?? "unknown";

    const row: ContextIndexRow = {
      dir_path: dirPath,
      overview_content: overviewContent,
      content_hash: hash,
      keywords,
      embedding: JSON.stringify(embeddingVec),
      embedding_signature: embeddingVec.length > 0 ? signature : "",
      embedding_dimensions: embeddingVec.length,
      embedding_status: embeddingVec.length > 0 ? "ready" : "missing",
      updated_at: new Date().toISOString(),
    };

    this.db.upsertContextIndex(row);
    return {
      indexed: 1,
      skipped: 0,
      missingEmbeddings: embeddingVec.length > 0 ? 0 : 1,
      providerFailed,
    };
  }

  /**
   * 重新索引指定目录（用于 context_write 后增量更新）。
   */
  private async reindexDirInner(dirPath: string): Promise<ContextIndexRunResult> {
    const overview = await this.contextHub.readOverview(dirPath);
    if (!overview) {
      this.db.deleteContextIndex(dirPath);
      return { indexed: 0, skipped: 0, missingEmbeddings: 0, providerFailed: false };
    }
    const old = this.db.getAllContextIndex().find((row) => row.dir_path === dirPath);
    const hash = this.indexHash(overview);
    const signature = this.embedding.getSignature?.() ?? "unknown";
    if (
      old && old.content_hash === hash && old.embedding_signature === signature &&
      old.embedding_status === "ready"
    ) {
      return { indexed: 0, skipped: 1, missingEmbeddings: 0, providerFailed: false };
    }
    return this.indexOne(dirPath, overview, hash, old);
  }

  private indexHash(text: string): string {
    return simpleHash(text);
  }

  private async rebuildAllInner(): Promise<ContextIndexRunResult> {
    const dirs = await this.contextHub.listDirectories();
    const existing = new Map(this.db.getAllContextIndex().map((row) => [row.dir_path, row]));
    const rows: ContextIndexRow[] = [];
    let missingEmbeddings = 0;
    let providerFailed = false;
    for (const dir of dirs) {
      const path = dir.startsWith("context-hub/") ? dir.slice("context-hub/".length) : dir;
      if (SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
      const overview = await this.contextHub.readOverview(path);
      if (!overview) continue;
      let vector: number[] = [];
      try {
        vector = await this.embedding.embed(overview);
        if (vector.length === 0) providerFailed = true;
      } catch {
        providerFailed = true;
      }
      const contentHash = this.indexHash(overview);
      const old = existing.get(path);
      if (vector.length === 0 && old?.content_hash === contentHash) {
        rows.push(old);
        missingEmbeddings += old.embedding_status === "ready" ? 0 : 1;
        continue;
      }
      if (vector.length === 0) missingEmbeddings++;
      const signature = this.embedding.getSignature?.() ?? "unknown";
      rows.push({
        dir_path: path,
        overview_content: overview,
        content_hash: contentHash,
        keywords: extractKeywords(path, overview),
        embedding: JSON.stringify(vector),
        embedding_signature: vector.length > 0 ? signature : "",
        embedding_dimensions: vector.length,
        embedding_status: vector.length > 0 ? "ready" : "missing",
        updated_at: new Date().toISOString(),
      });
    }
    this.db.replaceContextIndex(rows);
    return { indexed: rows.length, skipped: 0, missingEmbeddings, providerFailed };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.catch(() => {}).then(operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private observe(result: Promise<ContextIndexRunResult>): Promise<ContextIndexRunResult> {
    return result.then((value) => {
      if (value.providerFailed) this.providerFailureHandler?.();
      return value;
    });
  }
}

export interface ContextIndexRunResult {
  indexed: number;
  skipped: number;
  missingEmbeddings: number;
  providerFailed: boolean;
}

/**
 * 从目录路径和 overview 内容中提取关键词（用于 BM25）。
 */
function extractKeywords(dirPath: string, overview: string): string {
  const parts: string[] = [];

  // 目录路径按 / 和 - 拆分
  parts.push(...dirPath.split(/[-_/]/));

  // overview 内容
  parts.push(overview.slice(0, 2000));

  const text = parts.join(" ");
  const tokens = tokenize(text);
  return [...new Set(tokens)].join(" ");
}

/**
 * 简单的字符串 hash（用于变更检测，非安全用途）。
 */
function simpleHash(str: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(str);
  return hasher.digest("hex").slice(0, 16);
}
