import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { Database as SQLiteDatabase } from "bun:sqlite";
import type { EmbeddingProvider } from "./EmbeddingProvider.ts";
import { retrieveHybrid } from "../retrieval/HybridRetriever.ts";
import { tokenize } from "../retrieval/tokenizer.ts";
import { parseEmbedding } from "../retrieval/vector.ts";

const DEFAULT_PAGE_SIZE = 3_500;
const MAX_PAGE_SIZE = 8_000;
const DEFAULT_EXPIRES_DAYS = 7;
const DIGEST_MAX_CHARS = 800;
const SEARCH_CHUNK_SIZE = 3_500;
const SNIPPET_MAX_CHARS = 700;
const MAX_SEARCH_RESULTS = 10;

export interface ContentRefSection {
  section_id: string;
  title: string;
  summary: string;
  char_start: number;
  char_end: number;
}

export interface ContentRefDigest {
  type: "content_ref";
  ref_id: string;
  project?: string;
  source: string | null;
  title?: string;
  content_length: number;
  digest: string;
  key_points: string[];
  sections: ContentRefSection[];
  expires_at: string;
  read_tools: {
    read_page: string;
    read_section: string;
    search_within: string;
  };
}

export interface StoreTextInput {
  sourceTool: string;
  sourceUri?: string | null;
  title?: string;
  content: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  projectContextPath?: string;
}

export interface ReadContentRefInput {
  refId: string;
  page?: number;
  pageSize?: number;
  sectionId?: string;
  pageWithinSection?: number;
  offset?: number;
  limit?: number;
  projectContextPath?: string;
}

export interface SearchContentRefInput {
  refId: string;
  query: string;
  maxResults?: number;
  pageSize?: number;
  projectContextPath?: string;
}

export interface ContentStoreOptions {
  embeddingProvider?: EmbeddingProvider;
}

export interface CleanupExpiredRefsOptions {
  now?: Date;
  includeProjectRefs?: boolean;
}

export interface CleanupExpiredRefsResult {
  deletedRefs: number;
  deletedFiles: number;
}

interface StoredContentRefMeta {
  id: string;
  project?: string;
  project_context_path?: string;
  source_tool: string;
  source_uri: string | null;
  title?: string;
  content_hash: string;
  content_length: number;
  storage_path: string;
  mime_type?: string;
  created_at: string;
  expires_at: string;
  metadata: Record<string, unknown>;
  summary: {
    digest: string;
    key_points: string[];
    sections: ContentRefSection[];
  };
}

interface ContentRefChunk {
  id: string;
  ref_id: string;
  chunk_index: number;
  summary: string;
  char_start: number;
  char_end: number;
  token_estimate: number;
}

interface ContentRefChunkIndexRow {
  id: string;
  ref_id: string;
  chunk_id: string;
  project: string | null;
  title: string | null;
  chunk_text: string;
  keywords: string;
  embedding: string | null;
  embedding_status: string;
  embedding_signature: string | null;
  bm25_length: number;
  char_start: number;
  char_end: number;
  updated_at: string;
  chunk_index: number;
  summary: string | null;
}

interface ExpiredContentRefRow {
  id: string;
  project: string | null;
  storage_path: string;
}

export class ContentStore {
  private db?: SQLiteDatabase;

  constructor(
    private baseDir = join(homedir(), ".little_claw"),
    private options: ContentStoreOptions = {},
  ) {}

  async storeText(input: StoreTextInput): Promise<ContentRefDigest> {
    const content = input.content;
    const contentHash = sha256(content);
    const now = new Date();
    const refId = `ctx_${formatDate(now)}_${contentHash.slice(0, 12)}`;
    const location = this.resolveLocation(input.projectContextPath);
    mkdirSync(location.dir, { recursive: true });

    const storagePath = join(location.dir, `${refId}.txt`);
    const metaPath = join(location.dir, `${refId}.meta.json`);

    if (!existsSync(storagePath)) {
      await Bun.write(storagePath, content);
    }

    const existingMeta = await this.readMetaFile(metaPath);
    const summary = existingMeta?.summary ?? summarizeForDigest(content, input.title);
    const expiresAt = existingMeta?.expires_at ?? addDays(now, DEFAULT_EXPIRES_DAYS).toISOString();
    const metadata = {
      ...(existingMeta?.metadata ?? {}),
      ...(input.metadata ?? {}),
      sources: mergeSources(existingMeta?.metadata?.sources, input.sourceUri),
    };

    const meta: StoredContentRefMeta = {
      id: refId,
      project: location.project,
      project_context_path: location.projectContextPath,
      source_tool: input.sourceTool,
      source_uri: input.sourceUri ?? null,
      title: input.title,
      content_hash: contentHash,
      content_length: content.length,
      storage_path: storagePath,
      mime_type: input.mimeType,
      created_at: existingMeta?.created_at ?? now.toISOString(),
      expires_at: expiresAt,
      metadata,
      summary,
    };

    await Bun.write(metaPath, JSON.stringify(meta, null, 2));
    this.upsertIndex(meta, content);
    return this.toDigest(meta);
  }

  async readRef(input: ReadContentRefInput): Promise<Record<string, unknown>> {
    const modeCount =
      (input.sectionId ? 1 : 0) +
      (input.page != null ? 1 : 0) +
      (input.offset != null || input.limit != null ? 1 : 0);
    if (modeCount > 1) {
      throw new Error("Use only one locator: page, section_id, or offset/limit.");
    }

    const meta = await this.findMeta(input.refId, input.projectContextPath);
    if (!meta) {
      throw new Error(`Unknown content ref: ${input.refId}`);
    }
    if (!existsSync(meta.storage_path)) {
      throw new Error(`Content ref ${input.refId} is damaged or has been cleaned up.`);
    }

    const content = await Bun.file(meta.storage_path).text();
    const sourceChanged = this.isSourceChanged(meta);

    if (input.sectionId) {
      const section = meta.summary.sections.find((s) => s.section_id === input.sectionId);
      if (!section) {
        throw new Error(`Unknown section_id for ${input.refId}: ${input.sectionId}`);
      }
      const pageSize = clampPageSize(input.pageSize);
      const sectionLength = Math.max(0, section.char_end - section.char_start);
      const totalPages = Math.max(1, Math.ceil(sectionLength / pageSize));
      const page = clampPage(input.pageWithinSection ?? 1, totalPages);
      const charStart = section.char_start + (page - 1) * pageSize;
      const charEnd = Math.min(section.char_end, charStart + pageSize);
      return this.pageResult(meta, content, charStart, charEnd, {
        section,
        page,
        totalPages,
        sourceChanged,
      });
    }

    if (input.offset != null || input.limit != null) {
      const offset = Math.max(0, Math.floor(input.offset ?? 0));
      const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(input.limit ?? DEFAULT_PAGE_SIZE)));
      const charStart = Math.min(offset, content.length);
      const charEnd = Math.min(content.length, charStart + limit);
      return this.pageResult(meta, content, charStart, charEnd, {
        sourceChanged,
      });
    }

    const pageSize = clampPageSize(input.pageSize);
    const totalPages = Math.max(1, Math.ceil(content.length / pageSize));
    const page = clampPage(input.page ?? 1, totalPages);
    const charStart = (page - 1) * pageSize;
    const charEnd = Math.min(content.length, charStart + pageSize);
    const section = meta.summary.sections.find(
      (s) => charStart >= s.char_start && charStart < s.char_end,
    );

    return this.pageResult(meta, content, charStart, charEnd, {
      section,
      page,
      totalPages,
      sourceChanged,
    });
  }

  async searchRef(input: SearchContentRefInput): Promise<Record<string, unknown>> {
    const query = input.query.trim();
    if (!query) {
      throw new Error("Missing required parameter: query");
    }

    const meta = await this.findMeta(input.refId, input.projectContextPath);
    if (!meta) {
      throw new Error(`Unknown content ref: ${input.refId}`);
    }
    if (!existsSync(meta.storage_path)) {
      throw new Error(`Content ref ${input.refId} is damaged or has been cleaned up.`);
    }

    const content = await Bun.file(meta.storage_path).text();
    this.upsertIndex(meta, content);

    let rows = this.getChunkIndexRows(meta.id);
    const queryTokens = tokenize(query);
    const maxResults = clampSearchResults(input.maxResults);
    let queryEmbedding: number[] | undefined;
    let mode: "hybrid" | "bm25" = "bm25";
    let embedding_error: string | undefined;

    if (this.options.embeddingProvider) {
      const signature = this.options.embeddingProvider.getSignature?.() ?? "unknown";
      rows = await this.ensureEmbeddings(rows, signature);
      try {
        queryEmbedding = await this.options.embeddingProvider.embed(query);
        if (rows.some((row) => parseEmbedding(row.embedding))) {
          mode = "hybrid";
        }
      } catch (err) {
        embedding_error = err instanceof Error ? err.message : String(err);
        queryEmbedding = undefined;
      }
    }

    const rowById = new Map(rows.map((row) => [row.id, row]));
    const scored = retrieveHybrid({
      queryTokens,
      queryEmbedding,
      topK: maxResults,
      documents: rows.map((row) => ({
        id: row.id,
        tokens: row.keywords.split(/\s+/).filter(Boolean),
        embedding: mode === "hybrid" ? parseEmbedding(row.embedding) : undefined,
      })),
    });

    const pageSize = clampPageSize(input.pageSize);
    const results = scored
      .filter((result) => result.score > 0 || result.rawBm25Score > 0 || result.vectorScore > 0)
      .map((result) => {
        const row = rowById.get(result.id)!;
        const section = sectionForOffset(meta.summary.sections, row.char_start);
        const page = Math.floor(row.char_start / pageSize) + 1;
        return {
          ref_id: meta.id,
          score: roundScore(result.score),
          bm25_score: roundScore(result.bm25Score),
          vector_score: roundScore(result.vectorScore),
          match_reason: result.matchedTokens.length > 0
            ? `keyword: ${result.matchedTokens.join(", ")}`
            : mode === "hybrid" && result.vectorScore > 0
            ? `vector: ${result.vectorScore.toFixed(2)}`
            : "low relevance",
          chunk_index: row.chunk_index,
          page,
          section_id: section?.section_id,
          section_title: section?.title,
          char_start: row.char_start,
          char_end: row.char_end,
          snippet: buildSnippet(row.chunk_text, result.matchedTokens),
          read_page: `read_content_ref({ "ref_id": "${meta.id}", "page": ${page} })`,
        };
      });

    return {
      ref_id: meta.id,
      source: meta.source_uri,
      title: meta.title,
      query,
      mode,
      embedding_error,
      max_results: maxResults,
      results,
      note: results.length === 0
        ? "No matching chunks found. Try a broader query or read the digest sections."
        : "Use read_content_ref with page or section_id to inspect a result in more detail.",
    };
  }

  private pageResult(
    meta: StoredContentRefMeta,
    content: string,
    charStart: number,
    charEnd: number,
    options: {
      section?: ContentRefSection;
      page?: number;
      totalPages?: number;
      sourceChanged?: boolean;
    },
  ): Record<string, unknown> {
    return {
      ref_id: meta.id,
      source: meta.source_uri,
      title: meta.title,
      page: options.page,
      total_pages: options.totalPages,
      char_start: charStart,
      char_end: charEnd,
      section_id: options.section?.section_id,
      section_title: options.section?.title,
      section_summary: options.section?.summary,
      source_changed: options.sourceChanged,
      content: content.slice(charStart, charEnd),
      next_page: options.page && options.totalPages && options.page < options.totalPages
        ? options.page + 1
        : undefined,
      previous_page: options.page && options.page > 1 ? options.page - 1 : undefined,
    };
  }

  cleanupExpired(options: CleanupExpiredRefsOptions = {}): CleanupExpiredRefsResult {
    const now = (options.now ?? new Date()).toISOString();
    const db = this.getDb();
    const rows = db.prepare(
      `SELECT id, project, storage_path
       FROM content_refs
       WHERE expires_at IS NOT NULL AND expires_at <= ?1`,
    ).all(now) as ExpiredContentRefRow[];

    let deletedRefs = 0;
    let deletedFiles = 0;
    const deleteRef = db.prepare(`DELETE FROM content_refs WHERE id = ?1`);

    for (const row of rows) {
      if (row.project && !options.includeProjectRefs) continue;
      deleteRef.run(row.id);
      deletedRefs++;

      for (const path of [row.storage_path, metaPathFromStoragePath(row.storage_path)]) {
        if (!existsSync(path)) continue;
        try {
          unlinkSync(path);
          deletedFiles++;
        } catch {
          // Best-effort cleanup: SQLite state remains authoritative.
        }
      }
    }

    return { deletedRefs, deletedFiles };
  }

  private upsertIndex(meta: StoredContentRefMeta, content: string): void {
    const db = this.getDb();
    const chunks = buildChunks(meta.id, content);
    const now = new Date().toISOString();

    db.transaction(() => {
      db.prepare(
        `INSERT OR REPLACE INTO content_refs
          (id, project, source_tool, source_uri, title, content_hash, content_length,
           storage_path, mime_type, created_at, expires_at, metadata_json, summary_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).run(
        meta.id,
        meta.project ?? null,
        meta.source_tool,
        meta.source_uri,
        meta.title ?? null,
        meta.content_hash,
        meta.content_length,
        meta.storage_path,
        meta.mime_type ?? null,
        meta.created_at,
        meta.expires_at,
        JSON.stringify(meta.metadata),
        JSON.stringify(meta.summary),
      );

      db.prepare(`DELETE FROM content_ref_chunk_index WHERE ref_id = ?1`).run(meta.id);
      db.prepare(`DELETE FROM content_ref_chunks WHERE ref_id = ?1`).run(meta.id);
      db.prepare(`DELETE FROM content_ref_sections WHERE ref_id = ?1`).run(meta.id);

      const insertSection = db.prepare(
        `INSERT INTO content_ref_sections
          (id, ref_id, section_id, title, summary, char_start, char_end, ordinal)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      );
      meta.summary.sections.forEach((section, index) => {
        insertSection.run(
          `${meta.id}_${section.section_id}`,
          meta.id,
          section.section_id,
          section.title,
          section.summary,
          section.char_start,
          section.char_end,
          index,
        );
      });

      const insertChunk = db.prepare(
        `INSERT INTO content_ref_chunks
          (id, ref_id, chunk_index, summary, char_start, char_end, token_estimate)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      );
      const insertIndex = db.prepare(
        `INSERT INTO content_ref_chunk_index
          (id, ref_id, chunk_id, project, title, chunk_text, keywords, embedding,
           embedding_status, embedding_signature, bm25_length, char_start, char_end, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 'pending', NULL, ?8, ?9, ?10, ?11)`,
      );

      for (const chunk of chunks) {
        const chunkText = content.slice(chunk.char_start, chunk.char_end);
        const section = sectionForOffset(meta.summary.sections, chunk.char_start);
        const indexText = [
          meta.title,
          meta.summary.digest,
          meta.summary.key_points.join(" "),
          section?.title,
          section?.summary,
          chunk.summary,
          chunkText,
        ].filter(Boolean).join("\n");
        const keywords = tokenize(indexText).join(" ");

        insertChunk.run(
          chunk.id,
          chunk.ref_id,
          chunk.chunk_index,
          chunk.summary,
          chunk.char_start,
          chunk.char_end,
          chunk.token_estimate,
        );
        insertIndex.run(
          `${chunk.id}_idx`,
          meta.id,
          chunk.id,
          meta.project ?? null,
          meta.title ?? null,
          chunkText,
          keywords,
          keywords.split(/\s+/).filter(Boolean).length,
          chunk.char_start,
          chunk.char_end,
          now,
        );
      }
    })();
  }

  private async ensureEmbeddings(
    rows: ContentRefChunkIndexRow[],
    signature: string,
  ): Promise<ContentRefChunkIndexRow[]> {
    const provider = this.options.embeddingProvider;
    if (!provider) return rows;

    const db = this.getDb();
    const update = db.prepare(
      `UPDATE content_ref_chunk_index
       SET embedding = ?2, embedding_status = ?3, embedding_signature = ?4, updated_at = ?5
       WHERE id = ?1`,
    );
    const now = new Date().toISOString();

    const updated: ContentRefChunkIndexRow[] = [];
    for (const row of rows) {
      if (row.embedding_status === "ready" && row.embedding_signature === signature && row.embedding) {
        updated.push(row);
        continue;
      }

      try {
        const embedding = await provider.embed(row.chunk_text);
        const serialized = JSON.stringify(embedding);
        update.run(row.id, serialized, "ready", signature, now);
        updated.push({
          ...row,
          embedding: serialized,
          embedding_status: "ready",
          embedding_signature: signature,
          updated_at: now,
        });
      } catch {
        update.run(row.id, null, "failed", signature, now);
        updated.push({
          ...row,
          embedding: null,
          embedding_status: "failed",
          embedding_signature: signature,
          updated_at: now,
        });
      }
    }

    return updated;
  }

  private getChunkIndexRows(refId: string): ContentRefChunkIndexRow[] {
    return this.getDb().prepare(
      `SELECT
         i.id, i.ref_id, i.chunk_id, i.project, i.title, i.chunk_text, i.keywords,
         i.embedding, i.embedding_status, i.embedding_signature, i.bm25_length,
         i.char_start, i.char_end, i.updated_at,
         c.chunk_index, c.summary
       FROM content_ref_chunk_index i
       JOIN content_ref_chunks c ON c.id = i.chunk_id
       WHERE i.ref_id = ?1
       ORDER BY c.chunk_index ASC`,
    ).all(refId) as ContentRefChunkIndexRow[];
  }

  private getDb(): SQLiteDatabase {
    if (this.db) return this.db;
    mkdirSync(this.baseDir, { recursive: true });
    this.db = new SQLiteDatabase(join(this.baseDir, "content-store.sqlite"));
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.initTables(this.db);
    return this.db;
  }

  private initTables(db: SQLiteDatabase): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS content_refs (
        id TEXT PRIMARY KEY,
        project TEXT,
        source_tool TEXT NOT NULL,
        source_uri TEXT,
        title TEXT,
        content_hash TEXT NOT NULL,
        content_length INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        mime_type TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        metadata_json TEXT,
        summary_json TEXT
      )
    `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_content_refs_hash ON content_refs (content_hash)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_content_refs_source ON content_refs (source_tool, source_uri)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_content_refs_project ON content_refs (project, created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_content_refs_expires ON content_refs (expires_at)`);

    db.run(`
      CREATE TABLE IF NOT EXISTS content_ref_sections (
        id TEXT PRIMARY KEY,
        ref_id TEXT NOT NULL,
        section_id TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        char_start INTEGER NOT NULL,
        char_end INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        FOREIGN KEY (ref_id) REFERENCES content_refs(id) ON DELETE CASCADE
      )
    `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_content_ref_sections_ref_section ON content_ref_sections (ref_id, section_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_content_ref_sections_ref_ordinal ON content_ref_sections (ref_id, ordinal)`);

    db.run(`
      CREATE TABLE IF NOT EXISTS content_ref_chunks (
        id TEXT PRIMARY KEY,
        ref_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        summary TEXT,
        char_start INTEGER NOT NULL,
        char_end INTEGER NOT NULL,
        token_estimate INTEGER,
        FOREIGN KEY (ref_id) REFERENCES content_refs(id) ON DELETE CASCADE
      )
    `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_content_ref_chunks_ref_index ON content_ref_chunks (ref_id, chunk_index)`);

    db.run(`
      CREATE TABLE IF NOT EXISTS content_ref_chunk_index (
        id TEXT PRIMARY KEY,
        ref_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        project TEXT,
        title TEXT,
        chunk_text TEXT NOT NULL,
        keywords TEXT NOT NULL,
        embedding TEXT,
        embedding_status TEXT NOT NULL,
        embedding_signature TEXT,
        bm25_length INTEGER NOT NULL,
        char_start INTEGER NOT NULL,
        char_end INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (ref_id) REFERENCES content_refs(id) ON DELETE CASCADE,
        FOREIGN KEY (chunk_id) REFERENCES content_ref_chunks(id) ON DELETE CASCADE
      )
    `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_content_ref_chunk_index_chunk ON content_ref_chunk_index (chunk_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_content_ref_chunk_index_ref ON content_ref_chunk_index (ref_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_content_ref_chunk_index_project ON content_ref_chunk_index (project, updated_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_content_ref_chunk_index_embedding ON content_ref_chunk_index (embedding_status, embedding_signature)`);
  }

  private resolveLocation(projectContextPath?: string): {
    dir: string;
    project?: string;
    projectContextPath?: string;
  } {
    const normalized = normalizeProjectContextPath(projectContextPath);
    if (!normalized) {
      return { dir: join(this.baseDir, "content-refs") };
    }

    const project = normalized.slice("context-hub/3-projects/".length).split("/")[0] ?? "";
    return {
      dir: join(this.baseDir, "context-hub", "3-projects", project, "content-refs"),
      project,
      projectContextPath: `context-hub/3-projects/${project}`,
    };
  }

  private async findMeta(refId: string, projectContextPath?: string): Promise<StoredContentRefMeta | null> {
    const normalized = normalizeProjectContextPath(projectContextPath);
    const candidates: string[] = [];

    if (normalized) {
      const project = normalized.slice("context-hub/3-projects/".length).split("/")[0] ?? "";
      candidates.push(join(this.baseDir, "context-hub", "3-projects", project, "content-refs", `${refId}.meta.json`));
    }

    candidates.push(join(this.baseDir, "content-refs", `${refId}.meta.json`));

    const projectsDir = join(this.baseDir, "context-hub", "3-projects");
    if (existsSync(projectsDir)) {
      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        candidates.push(join(projectsDir, entry.name, "content-refs", `${refId}.meta.json`));
      }
    }

    for (const candidate of unique(candidates)) {
      const meta = await this.readMetaFile(candidate);
      if (meta) return meta;
    }
    return null;
  }

  private async readMetaFile(path: string): Promise<StoredContentRefMeta | null> {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await Bun.file(path).text()) as StoredContentRefMeta;
    } catch {
      return null;
    }
  }

  private toDigest(meta: StoredContentRefMeta): ContentRefDigest {
    return {
      type: "content_ref",
      ref_id: meta.id,
      project: meta.project,
      source: meta.source_uri,
      title: meta.title,
      content_length: meta.content_length,
      digest: meta.summary.digest,
      key_points: meta.summary.key_points,
      sections: meta.summary.sections.slice(0, 5),
      expires_at: meta.expires_at,
      read_tools: {
        read_page: `read_content_ref({ "ref_id": "${meta.id}", "page": 1 })`,
        read_section: `read_content_ref({ "ref_id": "${meta.id}", "section_id": "..." })`,
        search_within: `search_content_ref({ "ref_id": "${meta.id}", "query": "..." })`,
      },
    };
  }

  private isSourceChanged(meta: StoredContentRefMeta): boolean {
    if (meta.source_tool !== "read_file") return false;
    const filePath = typeof meta.metadata.file_path === "string" ? meta.metadata.file_path : null;
    if (!filePath || !existsSync(filePath)) return true;
    try {
      const stat = statSync(filePath);
      const oldSize = Number(meta.metadata.file_size_bytes);
      const oldMtime = Number(meta.metadata.file_mtime_ms);
      return stat.size !== oldSize || Math.round(stat.mtimeMs) !== Math.round(oldMtime);
    } catch {
      return true;
    }
  }
}

function summarizeForDigest(content: string, title?: string): StoredContentRefMeta["summary"] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const digest = truncate(
    firstParagraph(normalized) || title || "Stored long tool output.",
    DIGEST_MAX_CHARS,
  );
  const keyPoints = extractKeyPoints(normalized, title);
  const sections = buildSections(normalized);
  return { digest, key_points: keyPoints, sections };
}

function buildSections(content: string): ContentRefSection[] {
  const headingMatches = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)];
  if (headingMatches.length > 0) {
    return headingMatches.slice(0, 32).map((match, index) => {
      const start = match.index ?? 0;
      const next = headingMatches[index + 1]?.index ?? content.length;
      const title = truncate(match[1]?.trim() || `Section ${index + 1}`, 120);
      return {
        section_id: `s${index + 1}`,
        title,
        summary: truncate(firstParagraph(content.slice(start, next)) || title, 280),
        char_start: start,
        char_end: next,
      };
    });
  }

  const chunkSize = 4_000;
  const sections: ContentRefSection[] = [];
  for (let start = 0, index = 0; start < content.length; start += chunkSize, index++) {
    const end = Math.min(content.length, start + chunkSize);
    const slice = content.slice(start, end);
    sections.push({
      section_id: `s${index + 1}`,
      title: `Chunk ${index + 1}`,
      summary: truncate(firstParagraph(slice) || slice.trim(), 280),
      char_start: start,
      char_end: end,
    });
    if (sections.length >= 32) break;
  }
  return sections.length > 0 ? sections : [{
    section_id: "s1",
    title: "Content",
    summary: "",
    char_start: 0,
    char_end: 0,
  }];
}

function buildChunks(refId: string, content: string): ContentRefChunk[] {
  const chunks: ContentRefChunk[] = [];
  for (let start = 0, index = 0; start < content.length; start += SEARCH_CHUNK_SIZE, index++) {
    const end = Math.min(content.length, start + SEARCH_CHUNK_SIZE);
    const slice = content.slice(start, end);
    chunks.push({
      id: `${refId}_c${index + 1}`,
      ref_id: refId,
      chunk_index: index + 1,
      summary: truncate(firstParagraph(slice) || slice.trim(), 240),
      char_start: start,
      char_end: end,
      token_estimate: Math.ceil((end - start) / 4),
    });
  }

  return chunks.length > 0 ? chunks : [{
    id: `${refId}_c1`,
    ref_id: refId,
    chunk_index: 1,
    summary: "",
    char_start: 0,
    char_end: 0,
    token_estimate: 0,
  }];
}

function sectionForOffset(sections: ContentRefSection[], offset: number): ContentRefSection | undefined {
  return sections.find((section) => offset >= section.char_start && offset < section.char_end)
    ?? sections.find((section) => section.char_start === 0);
}

function buildSnippet(text: string, matched: string[]): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= SNIPPET_MAX_CHARS) return normalized;

  const lower = normalized.toLowerCase();
  const firstMatch = matched
    .map((token) => lower.indexOf(token.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstMatch - Math.floor(SNIPPET_MAX_CHARS / 3));
  const end = Math.min(normalized.length, start + SNIPPET_MAX_CHARS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
}

function extractKeyPoints(content: string, title?: string): string[] {
  const points: string[] = [];
  if (title) points.push(title);

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (/^[-*]\s+\S/.test(trimmed) || /^\d+[.)]\s+\S/.test(trimmed)) {
      points.push(truncate(trimmed.replace(/^[-*\d.)\s]+/, ""), 180));
    }
    if (points.length >= 4) break;
  }

  if (points.length < 3) {
    const paragraph = firstParagraph(content);
    if (paragraph) points.push(truncate(paragraph, 180));
  }

  return unique(points.filter(Boolean)).slice(0, 4);
}

function firstParagraph(content: string): string {
  return content
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .find((p) => p.length > 0) ?? "";
}

function normalizeProjectContextPath(path?: string): string | null {
  if (!path) return null;
  const trimmed = path.trim().replace(/\/+$/, "");
  const normalized = trimmed.startsWith("3-projects/")
    ? `context-hub/${trimmed}`
    : trimmed;
  return normalized.startsWith("context-hub/3-projects/") ? normalized : null;
}

function mergeSources(existing: unknown, sourceUri?: string | null): string[] {
  const sources = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];
  if (sourceUri) sources.push(sourceUri);
  return unique(sources);
}

function clampPageSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.max(500, Math.min(MAX_PAGE_SIZE, Math.floor(value)));
}

function clampPage(value: unknown, totalPages: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(totalPages, Math.floor(value)));
}

function clampSearchResults(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(value)));
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function metaPathFromStoragePath(path: string): string {
  return path.endsWith(".txt") ? `${path.slice(0, -4)}.meta.json` : `${path}.meta.json`;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function contentRefTitleFromPath(path: string): string {
  return basename(path);
}
