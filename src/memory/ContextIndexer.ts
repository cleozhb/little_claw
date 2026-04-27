/**
 * src/memory/ContextIndexer.ts — Context Hub .overview.md 索引构建器
 *
 * 扫描 context-hub/ 下的 .overview.md 文件，提取关键词、生成 embedding，
 * 写入 context_index 表。支持变更检测（内容 hash 不变则跳过）。
 *
 * 跳过 0-identity/ 和 1-inbox/（它们必定加载，不走检索）。
 */

import type { Database, ContextIndexRow } from "../db/Database.ts";
import type { EmbeddingProvider } from "./EmbeddingProvider.ts";
import type { ContextHub } from "./ContextHub.ts";
import { tokenize } from "../skills/tokenize.ts";

/** 不参与检索的目录前缀（必定加载） */
const SKIP_PREFIXES = ["0-identity", "1-inbox"];

export class ContextIndexer {
  constructor(
    private db: Database,
    private embedding: EmbeddingProvider,
    private contextHub: ContextHub,
  ) {}

  /**
   * 对所有 .overview.md 建立索引（跳过未变化的）。
   */
  async indexAll(): Promise<void> {
    const existing = new Map<string, ContextIndexRow>();
    for (const row of this.db.getAllContextIndex()) {
      existing.set(row.dir_path, row);
    }

    // 扫描 context-hub 下所有目录
    const dirs = await this.contextHub.listDirectories();
    const indexedPaths = new Set<string>();

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
      const contentHash = simpleHash(overview);

      // 变更检测
      if (old && old.content_hash === contentHash) continue;

      await this.indexOne(relativePath, overview, contentHash);
    }

    // 删除已不存在的索引
    for (const dirPath of existing.keys()) {
      if (!indexedPaths.has(dirPath)) {
        this.db.deleteContextIndex(dirPath);
      }
    }
  }

  /**
   * 对单个目录的 .overview.md 建立索引。
   */
  async indexOne(
    dirPath: string,
    overviewContent: string,
    contentHash?: string,
  ): Promise<void> {
    const hash = contentHash ?? simpleHash(overviewContent);
    const keywords = extractKeywords(dirPath, overviewContent);
    const embeddingVec = await this.embedding.embed(overviewContent);

    const row: ContextIndexRow = {
      dir_path: dirPath,
      overview_content: overviewContent,
      content_hash: hash,
      keywords,
      embedding: JSON.stringify(embeddingVec),
      updated_at: new Date().toISOString(),
    };

    this.db.upsertContextIndex(row);
  }

  /**
   * 重新索引指定目录（用于 context_write 后增量更新）。
   */
  async reindexDir(dirPath: string): Promise<void> {
    const overview = await this.contextHub.readOverview(dirPath);
    if (!overview) {
      this.db.deleteContextIndex(dirPath);
      return;
    }
    await this.indexOne(dirPath, overview);
  }
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
