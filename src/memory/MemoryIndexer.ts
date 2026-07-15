import type { Database, MemoryIndexRow } from "../db/Database.ts";
import { tokenizeUnique } from "../retrieval/tokenizer.ts";
import type { EmbeddingProvider } from "./EmbeddingProvider.ts";
import type { MemorySourceKind } from "./MemoryStore.ts";
import { MemoryStore } from "./MemoryStore.ts";

const MAX_CHUNK_CHARS = 1_800;
const OVERLAP_CHARS = 180;

export class MemoryIndexer {
  private mutationTail: Promise<void> = Promise.resolve();
  private providerFailureHandler?: () => void;

  constructor(
    private db: Database,
    private embedding: EmbeddingProvider,
    private memoryStore: MemoryStore,
  ) {}

  indexAll(): Promise<MemoryIndexRunResult> {
    return this.observe(this.enqueue(() => this.indexAllInner()));
  }

  rebuildAll(): Promise<MemoryIndexRunResult> {
    return this.observe(this.enqueue(() => this.rebuildAllInner()));
  }

  reindexFile(sourcePath: string): Promise<MemoryIndexRunResult> {
    return this.observe(this.enqueue(() => this.reindexFileInner(sourcePath)));
  }

  onProviderFailure(handler: () => void): void {
    this.providerFailureHandler = handler;
  }

  async drain(): Promise<void> {
    await this.mutationTail;
  }

  private async indexAllInner(): Promise<MemoryIndexRunResult> {
    const files = await this.memoryStore.listIndexableFiles();
    const livePaths = new Set(files.map((file) => file.path));
    let indexed = 0;
    let skipped = 0;
    let missingEmbeddings = 0;
    let providerFailed = false;

    for (const file of files) {
      const content = await Bun.file(file.absolutePath).text();
      const result = await this.indexFileContent(file.path, file.kind, content, true);
      indexed += result.indexed;
      skipped += result.skipped;
      missingEmbeddings += result.missingEmbeddings;
      providerFailed ||= result.providerFailed;
    }

    for (const row of this.db.getAllMemoryIndex()) {
      if (!livePaths.has(row.source_path)) {
        this.db.deleteMemoryIndexBySourcePath(row.source_path);
      }
    }
    return { indexed, skipped, missingEmbeddings, providerFailed };
  }

  private async rebuildAllInner(): Promise<MemoryIndexRunResult> {
    const files = await this.memoryStore.listIndexableFiles();
    const existingBySource = new Map<string, MemoryIndexRow[]>();
    for (const row of this.db.getAllMemoryIndex()) {
      const rows = existingBySource.get(row.source_path) ?? [];
      rows.push(row);
      existingBySource.set(row.source_path, rows);
    }
    const rows: MemoryIndexRow[] = [];
    let missingEmbeddings = 0;
    let providerFailed = false;
    for (const file of files) {
      const content = await Bun.file(file.absolutePath).text();
      const built = await this.buildRows(file.path, file.kind, content);
      const existing = existingBySource.get(file.path) ?? [];
      const fileHash = hashText(content);
      if (
        built.providerFailed && existing.length > 0 &&
        existing.every((row) => row.file_hash === fileHash)
      ) {
        rows.push(...existing);
        missingEmbeddings += existing.filter((row) => row.embedding_status !== "ready").length;
        providerFailed = true;
        continue;
      }
      rows.push(...built.rows);
      missingEmbeddings += built.missingEmbeddings;
      providerFailed ||= built.providerFailed;
    }
    this.db.replaceAllMemoryIndex(rows);
    return { indexed: rows.length, skipped: 0, missingEmbeddings, providerFailed };
  }

  private async reindexFileInner(sourcePath: string): Promise<MemoryIndexRunResult> {
    const path = normalizeMemorySourcePath(sourcePath);
    const content = await this.memoryStore.readMemory(path);
    if (content === null) {
      this.db.deleteMemoryIndexBySourcePath(path);
      return { indexed: 0, skipped: 0, missingEmbeddings: 0, providerFailed: false };
    }
    return this.indexFileContent(path, inferSourceKind(path), content, true);
  }

  private async indexFileContent(
    sourcePath: string,
    sourceKind: MemorySourceKind,
    content: string,
    preserveUnchangedOnFailure: boolean,
  ): Promise<MemoryIndexRunResult> {
    const fileHash = hashText(content);
    const signature = this.embedding.getSignature?.() ?? "unknown";
    const existing = this.db.getMemoryIndexBySourcePath(sourcePath);
    if (
      existing.length > 0 &&
      existing.every((row) =>
        row.file_hash === fileHash &&
        row.embedding_signature === signature &&
        row.embedding_status === "ready"
      )
    ) {
      return { indexed: 0, skipped: existing.length, missingEmbeddings: 0, providerFailed: false };
    }

    const built = await this.buildRows(sourcePath, sourceKind, content);
    if (
      built.providerFailed &&
      preserveUnchangedOnFailure &&
      existing.length > 0 &&
      existing.every((row) => row.file_hash === fileHash)
    ) {
      return {
        indexed: 0,
        skipped: existing.length,
        missingEmbeddings: existing.filter((row) => row.embedding_status !== "ready").length,
        providerFailed: true,
      };
    }
    this.db.replaceMemoryIndexForSource(sourcePath, built.rows);
    return {
      indexed: built.rows.length,
      skipped: 0,
      missingEmbeddings: built.missingEmbeddings,
      providerFailed: built.providerFailed,
    };
  }

  private async buildRows(
    sourcePath: string,
    sourceKind: MemorySourceKind,
    content: string,
  ): Promise<{ rows: MemoryIndexRow[]; missingEmbeddings: number; providerFailed: boolean }> {
    const fileHash = hashText(content);
    const chunks = chunkMarkdown(content);
    const updatedAt = new Date().toISOString();
    const vectors: number[][] = [];
    let providerFailed = false;
    for (const chunk of chunks) {
      try {
        const vector = await this.embedding.embed(chunk);
        if (vector.length === 0) {
          providerFailed = true;
          break;
        }
        vectors.push(vector);
      } catch {
        providerFailed = true;
        break;
      }
    }
    const allReady = !providerFailed && vectors.length === chunks.length && vectors.every((v) => v.length > 0);
    const signature = this.embedding.getSignature?.() ?? "unknown";
    const rows: MemoryIndexRow[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const embedding = allReady ? vectors[i]! : [];
      const row: MemoryIndexRow = {
        id: `${sourcePath}#${i}`,
        source_path: sourcePath,
        source_kind: sourceKind,
        chunk_index: i,
        content: chunk,
        file_hash: fileHash,
        chunk_hash: hashText(chunk),
        keywords: tokenizeUnique(`${sourcePath}\n${chunk}`).join(" "),
        embedding: JSON.stringify(embedding),
        embedding_signature: embedding.length > 0 ? signature : "",
        embedding_dimensions: embedding.length,
        embedding_status: embedding.length > 0 ? "ready" : "missing",
        updated_at: updatedAt,
      };
      rows.push(row);
    }
    return {
      rows,
      missingEmbeddings: allReady ? 0 : rows.length,
      providerFailed,
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.catch(() => {}).then(operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private observe(result: Promise<MemoryIndexRunResult>): Promise<MemoryIndexRunResult> {
    return result.then((value) => {
      if (value.providerFailed) this.providerFailureHandler?.();
      return value;
    });
  }
}

export interface MemoryIndexRunResult {
  indexed: number;
  skipped: number;
  missingEmbeddings: number;
  providerFailed: boolean;
}

export function normalizeMemorySourcePath(sourcePath: string): string {
  const trimmed = sourcePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  return trimmed.startsWith("memory/") ? trimmed.slice("memory/".length) : trimmed;
}

function inferSourceKind(path: string): MemorySourceKind {
  if (path === "MEMORY.md") return "memory";
  if (path === "inbox.md") return "inbox";
  if (path.startsWith("daily/")) return "daily";
  return "memory";
}

function chunkMarkdown(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const blocks = trimmed
    .split(/\n(?=#{1,6}\s)|\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }
    if (current.length + block.length + 2 <= MAX_CHUNK_CHARS) {
      current += `\n\n${block}`;
      continue;
    }
    chunks.push(current);
    current = block;
  }
  if (current) chunks.push(current);

  const splitChunks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= MAX_CHUNK_CHARS) {
      splitChunks.push(chunk);
      continue;
    }
    for (let start = 0; start < chunk.length; start += MAX_CHUNK_CHARS - OVERLAP_CHARS) {
      splitChunks.push(chunk.slice(start, start + MAX_CHUNK_CHARS).trim());
    }
  }

  return splitChunks.filter(Boolean);
}

function hashText(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex").slice(0, 32);
}
