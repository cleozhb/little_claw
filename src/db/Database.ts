import { Database as SQLiteDatabase } from "bun:sqlite";

// --- Record Types ---

export interface Session {
  id: string;
  title: string | null;
  system_prompt: string | null;
  last_summary: string | null;
  mode: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  session_id: string;
  role: string;
  content: string; // JSON string
  created_at: string;
}

export interface ToolResultRecord {
  id: string;
  session_id: string;
  message_id: string;
  tool_use_id: string;
  tool_name: string;
  tool_input: string; // JSON string
  tool_output: string;
  is_error: number; // 0 | 1
  created_at: string;
}

export interface AddToolResultParams {
  sessionId: string;
  messageId: string;
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  toolOutput: string;
  isError?: boolean;
}

export interface SkillIndexRow {
  skill_name: string;
  description: string;
  instructions_summary: string;
  keywords: string;
  embedding: string; // JSON-serialized number[]
  updated_at: string;
}

export interface ContextIndexRow {
  dir_path: string;           // e.g. "2-areas/content"
  overview_content: string;   // the .overview.md content
  content_hash: string;       // for change detection
  keywords: string;           // tokenized keywords for BM25
  embedding: string;          // JSON-serialized number[]
  embedding_signature: string;
  embedding_dimensions: number;
  embedding_status: "ready" | "missing";
  updated_at: string;
}

export interface MemoryIndexRow {
  id: string;
  source_path: string;        // e.g. "MEMORY.md" or "daily/2026-07-11.md"
  source_kind: "memory" | "inbox" | "daily";
  chunk_index: number;
  content: string;
  file_hash: string;
  chunk_hash: string;
  keywords: string;
  embedding: string;          // JSON-serialized number[], or [] when unavailable
  embedding_signature: string;
  embedding_dimensions: number;
  embedding_status: "ready" | "missing";
  updated_at: string;
}

export interface MemoryFlushState {
  sessionId: string;
  dailyCursorMessageId: string | null;
  longTermCursorMessageId: string | null;
  lastDailyFlushAt: string | null;
  lastLongTermFlushAt: string | null;
  updatedAt: string;
}

interface MemoryFlushStateRow {
  session_id: string;
  daily_cursor_message_id: string | null;
  long_term_cursor_message_id: string | null;
  last_daily_flush_at: string | null;
  last_long_term_flush_at: string | null;
  updated_at: string;
}

export interface SessionApprovalRecord {
  id: string;
  session_id: string;
  tool_name: string;
  params: string;             // JSON
  rule: string | null;        // JSON
  message: string;
  status: string;             // pending | approved | rejected
  created_at: string;
  resolved_at: string | null;
}

// --- Database Class ---

export class Database {
  private db: SQLiteDatabase;

  // Prepared statements
  private stmtInsertSession;
  private stmtGetSession;
  private stmtListSessions;
  private stmtListAllSessions;
  private stmtDeleteSession;
  private stmtDeleteSessionMessages;
  private stmtDeleteSessionToolResults;
  private stmtUpdateSessionTitle;
  private stmtUpdateSessionSummary;
  private stmtUpdateSessionTimestamp;
  private stmtInsertMessage;
  private stmtGetMessages;
  private stmtGetMessagesAfter;
  private stmtGetMessageCount;
  private stmtInsertToolResult;
  private stmtGetToolResults;
  private stmtUpsertSkillIndex;
  private stmtGetAllSkillIndex;
  private stmtDeleteSkillIndex;
  private stmtClearSkillIndex;
  private stmtUpsertContextIndex;
  private stmtGetAllContextIndex;
  private stmtDeleteContextIndex;
  private stmtClearContextIndex;
  private stmtUpsertMemoryIndex;
  private stmtGetAllMemoryIndex;
  private stmtGetMemoryIndexBySourcePath;
  private stmtDeleteMemoryIndexBySourcePath;
  private stmtClearMemoryIndex;
  private stmtCountMemoryIndex;
  private stmtInsertSessionApproval;
  private stmtGetPendingApproval;
  private stmtResolveApproval;
  private stmtGetApprovedCallKeys;
  private stmtDeleteSessionApprovals;
  private stmtUpdateToolResult;
  private stmtInsertMemoryFlushState;
  private stmtGetMemoryFlushState;
  private stmtUpdateDailyCursor;
  private stmtUpdateLongTermCursor;
  private stmtDeleteMemoryFlushState;

  constructor(dbPath: string) {
    this.db = new SQLiteDatabase(dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");

    this.initTables();

    // Prepare all statements
    this.stmtInsertSession = this.db.prepare(
      `INSERT INTO sessions (id, title, system_prompt, last_summary, mode, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    );

    this.stmtGetSession = this.db.prepare(
      `SELECT * FROM sessions WHERE id = ?1`
    );

    this.stmtListSessions = this.db.prepare(
      `SELECT * FROM sessions WHERE mode = 'chat' ORDER BY updated_at DESC LIMIT ?1`
    );

    this.stmtListAllSessions = this.db.prepare(
      `SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?1`
    );

    this.stmtDeleteSession = this.db.prepare(
      `DELETE FROM sessions WHERE id = ?1`
    );

    this.stmtDeleteSessionMessages = this.db.prepare(
      `DELETE FROM messages WHERE session_id = ?1`
    );

    this.stmtDeleteSessionToolResults = this.db.prepare(
      `DELETE FROM tool_results WHERE session_id = ?1`
    );

    this.stmtUpdateSessionTitle = this.db.prepare(
      `UPDATE sessions SET title = ?2, updated_at = ?3 WHERE id = ?1`
    );

    this.stmtUpdateSessionSummary = this.db.prepare(
      `UPDATE sessions SET last_summary = ?2, updated_at = ?3 WHERE id = ?1`
    );

    this.stmtUpdateSessionTimestamp = this.db.prepare(
      `UPDATE sessions SET updated_at = ?2 WHERE id = ?1`
    );

    this.stmtInsertMessage = this.db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    );

    this.stmtGetMessages = this.db.prepare(
      `SELECT * FROM messages WHERE session_id = ?1 ORDER BY rowid ASC`
    );

    this.stmtGetMessagesAfter = this.db.prepare(
      `SELECT m.* FROM messages m
       WHERE m.session_id = ?1
         AND m.rowid > COALESCE((
           SELECT cursor.rowid FROM messages cursor
           WHERE cursor.session_id = ?1 AND cursor.id = ?2
         ), 0)
       ORDER BY m.rowid ASC`
    );

    this.stmtGetMessageCount = this.db.prepare(
      `SELECT COUNT(*) as count FROM messages WHERE session_id = ?1`
    );

    this.stmtInsertToolResult = this.db.prepare(
      `INSERT INTO tool_results (id, session_id, message_id, tool_use_id, tool_name, tool_input, tool_output, is_error, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    );

    this.stmtGetToolResults = this.db.prepare(
      `SELECT * FROM tool_results WHERE message_id = ?1 ORDER BY rowid ASC`
    );

    this.stmtUpsertSkillIndex = this.db.prepare(
      `INSERT OR REPLACE INTO skill_index (skill_name, description, instructions_summary, keywords, embedding, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    );

    this.stmtGetAllSkillIndex = this.db.prepare(
      `SELECT * FROM skill_index`
    );

    this.stmtDeleteSkillIndex = this.db.prepare(
      `DELETE FROM skill_index WHERE skill_name = ?1`
    );

    this.stmtClearSkillIndex = this.db.prepare(
      `DELETE FROM skill_index`
    );

    this.stmtUpsertContextIndex = this.db.prepare(
      `INSERT OR REPLACE INTO context_index (
         dir_path, overview_content, content_hash, keywords, embedding,
         embedding_signature, embedding_dimensions, embedding_status, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    );

    this.stmtGetAllContextIndex = this.db.prepare(
      `SELECT * FROM context_index`
    );

    this.stmtDeleteContextIndex = this.db.prepare(
      `DELETE FROM context_index WHERE dir_path = ?1`
    );

    this.stmtClearContextIndex = this.db.prepare(
      `DELETE FROM context_index`
    );

    this.stmtUpsertMemoryIndex = this.db.prepare(
      `INSERT OR REPLACE INTO memory_index (
        id, source_path, source_kind, chunk_index, content, file_hash, chunk_hash,
        keywords, embedding, embedding_signature, embedding_dimensions, embedding_status, updated_at
      )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    );

    this.stmtGetAllMemoryIndex = this.db.prepare(
      `SELECT * FROM memory_index`
    );

    this.stmtGetMemoryIndexBySourcePath = this.db.prepare(
      `SELECT * FROM memory_index WHERE source_path = ?1 ORDER BY chunk_index ASC`
    );

    this.stmtDeleteMemoryIndexBySourcePath = this.db.prepare(
      `DELETE FROM memory_index WHERE source_path = ?1`
    );

    this.stmtClearMemoryIndex = this.db.prepare(
      `DELETE FROM memory_index`
    );

    this.stmtCountMemoryIndex = this.db.prepare(
      `SELECT COUNT(*) as count FROM memory_index`
    );

    this.stmtInsertSessionApproval = this.db.prepare(
      `INSERT INTO session_approvals (id, session_id, tool_name, params, rule, message, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)`
    );

    this.stmtGetPendingApproval = this.db.prepare(
      `SELECT * FROM session_approvals WHERE session_id = ?1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`
    );

    this.stmtResolveApproval = this.db.prepare(
      `UPDATE session_approvals SET status = ?2, resolved_at = ?3 WHERE id = ?1`
    );

    this.stmtGetApprovedCallKeys = this.db.prepare(
      `SELECT tool_name, params FROM session_approvals WHERE session_id = ?1 AND status = 'approved'`
    );

    this.stmtDeleteSessionApprovals = this.db.prepare(
      `DELETE FROM session_approvals WHERE session_id = ?1`
    );

    this.stmtUpdateToolResult = this.db.prepare(
      `UPDATE tool_results SET tool_output = ?2, is_error = ?3 WHERE tool_use_id = ?1`
    );

    this.stmtInsertMemoryFlushState = this.db.prepare(
      `INSERT OR IGNORE INTO memory_flush_state (
         session_id, daily_cursor_message_id, long_term_cursor_message_id,
         last_daily_flush_at, last_long_term_flush_at, updated_at
       ) VALUES (?1, NULL, NULL, NULL, NULL, ?2)`
    );
    this.stmtGetMemoryFlushState = this.db.prepare(
      `SELECT * FROM memory_flush_state WHERE session_id = ?1`
    );
    this.stmtUpdateDailyCursor = this.db.prepare(
      `UPDATE memory_flush_state
       SET daily_cursor_message_id = ?2, last_daily_flush_at = ?3, updated_at = ?3
       WHERE session_id = ?1`
    );
    this.stmtUpdateLongTermCursor = this.db.prepare(
      `UPDATE memory_flush_state
       SET long_term_cursor_message_id = ?2, last_long_term_flush_at = ?3, updated_at = ?3
       WHERE session_id = ?1`
    );
    this.stmtDeleteMemoryFlushState = this.db.prepare(
      `DELETE FROM memory_flush_state WHERE session_id = ?1`
    );
  }

  private initTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        title        TEXT,
        system_prompt TEXT,
        last_summary TEXT,
        mode         TEXT NOT NULL DEFAULT 'chat',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      )
    `);

    // Migration: add last_summary column for existing databases
    try {
      this.db.run(`ALTER TABLE sessions ADD COLUMN last_summary TEXT`);
    } catch {
      // Column already exists — ignore
    }

    // Migration: add mode column for existing databases
    try {
      this.db.run(`ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'`);
    } catch {
      // Column already exists — ignore
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_time
        ON messages (session_id, created_at)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS tool_results (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        message_id   TEXT NOT NULL,
        tool_use_id  TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        tool_input   TEXT NOT NULL,
        tool_output  TEXT NOT NULL,
        is_error     INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (message_id) REFERENCES messages(id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS skill_index (
        skill_name          TEXT PRIMARY KEY,
        description         TEXT NOT NULL,
        instructions_summary TEXT NOT NULL,
        keywords            TEXT NOT NULL,
        embedding           TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS context_index (
        dir_path         TEXT PRIMARY KEY,
        overview_content TEXT NOT NULL,
        content_hash     TEXT NOT NULL,
        keywords         TEXT NOT NULL,
        embedding        TEXT NOT NULL,
        embedding_signature TEXT NOT NULL DEFAULT '',
        embedding_dimensions INTEGER NOT NULL DEFAULT 0,
        embedding_status TEXT NOT NULL DEFAULT 'missing',
        updated_at       TEXT NOT NULL
      )
    `);

    try {
      this.db.run(`ALTER TABLE context_index ADD COLUMN embedding_signature TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.run(`ALTER TABLE context_index ADD COLUMN embedding_dimensions INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.run(`ALTER TABLE context_index ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'missing'`);
    } catch {
      // Column already exists — ignore
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_index (
        id                  TEXT PRIMARY KEY,
        source_path         TEXT NOT NULL,
        source_kind         TEXT NOT NULL,
        chunk_index         INTEGER NOT NULL,
        content             TEXT NOT NULL,
        file_hash           TEXT NOT NULL,
        chunk_hash          TEXT NOT NULL,
        keywords            TEXT NOT NULL,
        embedding           TEXT NOT NULL,
        embedding_signature TEXT NOT NULL DEFAULT '',
        embedding_dimensions INTEGER NOT NULL DEFAULT 0,
        embedding_status     TEXT NOT NULL DEFAULT 'missing',
        updated_at          TEXT NOT NULL
      )
    `);

    try {
      this.db.run(`ALTER TABLE memory_index ADD COLUMN embedding_signature TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists — ignore
    }

    try {
      this.db.run(`ALTER TABLE memory_index ADD COLUMN embedding_dimensions INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.run(`ALTER TABLE memory_index ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'missing'`);
    } catch {
      // Column already exists — ignore
    }

    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_index_source_chunk
        ON memory_index (source_path, chunk_index)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_memory_index_source_path
        ON memory_index (source_path)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_approvals (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        params       TEXT NOT NULL,
        rule         TEXT,
        message      TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TEXT NOT NULL,
        resolved_at  TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_flush_state (
        session_id                   TEXT PRIMARY KEY,
        daily_cursor_message_id      TEXT,
        long_term_cursor_message_id  TEXT,
        last_daily_flush_at          TEXT,
        last_long_term_flush_at      TEXT,
        updated_at                   TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // Existing sessions are considered already processed at upgrade time. New sessions
    // insert an empty state transactionally in createSession().
    const now = new Date().toISOString();
    this.db.query(
      `INSERT OR IGNORE INTO memory_flush_state (
         session_id, daily_cursor_message_id, long_term_cursor_message_id,
         last_daily_flush_at, last_long_term_flush_at, updated_at
       )
       SELECT s.id,
              (SELECT m.id FROM messages m WHERE m.session_id = s.id ORDER BY m.rowid DESC LIMIT 1),
              (SELECT m.id FROM messages m WHERE m.session_id = s.id ORDER BY m.rowid DESC LIMIT 1),
              NULL, NULL, ?1
       FROM sessions s`,
    ).run(now);

    this.migrateEmbeddingMetadata();

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_session_approvals_session_status
        ON session_approvals (session_id, status)
    `);
  }

  private migrateEmbeddingMetadata(): void {
    const migrate = (table: "memory_index" | "context_index") => {
      const rows = this.db.query(
        `SELECT rowid, embedding, embedding_signature, embedding_dimensions, embedding_status FROM ${table}`,
      ).all() as Array<{
        rowid: number;
        embedding: string;
        embedding_signature: string;
        embedding_dimensions: number;
        embedding_status: string;
      }>;
      const update = this.db.prepare(
        `UPDATE ${table} SET embedding_dimensions = ?2, embedding_status = ?3 WHERE rowid = ?1`,
      );
      const tx = this.db.transaction(() => {
        for (const row of rows) {
          if (row.embedding_dimensions > 0 && row.embedding_status === "ready") continue;
          let dimensions = 0;
          try {
            const parsed = JSON.parse(row.embedding);
            dimensions = Array.isArray(parsed) ? parsed.length : 0;
          } catch {
            dimensions = 0;
          }
          const status = dimensions > 0 && row.embedding_signature ? "ready" : "missing";
          update.run(row.rowid, dimensions, status);
        }
      });
      tx();
    };
    migrate("memory_index");
    migrate("context_index");
  }

  // --- Session CRUD ---

  createSession(systemPrompt?: string, mode: string = "chat"): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: crypto.randomUUID(),
      title: null,
      system_prompt: systemPrompt ?? null,
      last_summary: null,
      mode,
      created_at: now,
      updated_at: now,
    };

    this.db.transaction(() => {
      this.stmtInsertSession.run(
        session.id,
        session.title,
        session.system_prompt,
        session.last_summary,
        session.mode,
        session.created_at,
        session.updated_at
      );
      this.stmtInsertMemoryFlushState.run(session.id, session.created_at);
    })();

    return session;
  }

  getSession(id: string): Session | null {
    return (this.stmtGetSession.get(id) as Session) ?? null;
  }

  listSessions(limit: number = 100): Session[] {
    return this.stmtListSessions.all(limit) as Session[];
  }

  listAllSessions(limit: number = 10_000): Session[] {
    return this.stmtListAllSessions.all(limit) as Session[];
  }

  deleteSession(id: string): void {
    this.db.transaction(() => {
      // Delete related data first (respect foreign keys)
      this.stmtDeleteSessionApprovals.run(id);
      this.stmtDeleteSessionToolResults.run(id);
      this.stmtDeleteSessionMessages.run(id);
      this.stmtDeleteMemoryFlushState.run(id);
      this.stmtDeleteSession.run(id);
    })();
  }

  updateSessionTitle(id: string, title: string): void {
    const now = new Date().toISOString();
    this.stmtUpdateSessionTitle.run(id, title, now);
  }

  updateSessionSummary(id: string, summary: string): void {
    const now = new Date().toISOString();
    this.stmtUpdateSessionSummary.run(id, summary, now);
  }

  updateSessionTimestamp(id: string): void {
    const now = new Date().toISOString();
    this.stmtUpdateSessionTimestamp.run(id, now);
  }

  // --- Message CRUD ---

  addMessage(sessionId: string, role: string, content: unknown): MessageRecord {
    const now = new Date().toISOString();
    const record: MessageRecord = {
      id: crypto.randomUUID(),
      session_id: sessionId,
      role,
      content: typeof content === "string" ? content : JSON.stringify(content),
      created_at: now,
    };

    this.stmtInsertMessage.run(
      record.id,
      record.session_id,
      record.role,
      record.content,
      record.created_at
    );

    // Update session timestamp
    this.updateSessionTimestamp(sessionId);

    return record;
  }

  getMessages(sessionId: string): MessageRecord[] {
    return this.stmtGetMessages.all(sessionId) as MessageRecord[];
  }

  getMessagesAfter(sessionId: string, cursorMessageId: string | null): MessageRecord[] {
    return this.stmtGetMessagesAfter.all(sessionId, cursorMessageId ?? "") as MessageRecord[];
  }

  getMemoryFlushState(sessionId: string): MemoryFlushState {
    this.createMemoryFlushState(sessionId);
    const row = this.stmtGetMemoryFlushState.get(sessionId) as MemoryFlushStateRow | undefined;
    if (!row) throw new Error(`Memory flush state not found for session ${sessionId}`);
    return {
      sessionId: row.session_id,
      dailyCursorMessageId: row.daily_cursor_message_id,
      longTermCursorMessageId: row.long_term_cursor_message_id,
      lastDailyFlushAt: row.last_daily_flush_at,
      lastLongTermFlushAt: row.last_long_term_flush_at,
      updatedAt: row.updated_at,
    };
  }

  createMemoryFlushState(sessionId: string): void {
    this.stmtInsertMemoryFlushState.run(sessionId, new Date().toISOString());
  }

  updateDailyCursor(sessionId: string, messageId: string, flushedAt: string): void {
    this.createMemoryFlushState(sessionId);
    this.stmtUpdateDailyCursor.run(sessionId, messageId, flushedAt);
  }

  updateLongTermCursor(sessionId: string, messageId: string, flushedAt: string): void {
    this.createMemoryFlushState(sessionId);
    this.stmtUpdateLongTermCursor.run(sessionId, messageId, flushedAt);
  }

  getMessageCount(sessionId: string): number {
    const row = this.stmtGetMessageCount.get(sessionId) as { count: number };
    return row.count;
  }

  // --- Tool Result CRUD ---

  addToolResult(params: AddToolResultParams): void {
    const now = new Date().toISOString();

    this.stmtInsertToolResult.run(
      crypto.randomUUID(),
      params.sessionId,
      params.messageId,
      params.toolUseId,
      params.toolName,
      typeof params.toolInput === "string"
        ? params.toolInput
        : JSON.stringify(params.toolInput),
      params.toolOutput,
      params.isError ? 1 : 0,
      now
    );
  }

  getToolResults(messageId: string): ToolResultRecord[] {
    return this.stmtGetToolResults.all(messageId) as ToolResultRecord[];
  }

  updateToolResult(toolUseId: string, output: string, isError: boolean): void {
    this.stmtUpdateToolResult.run(toolUseId, output, isError ? 1 : 0);
  }

  // --- Skill Index CRUD ---

  upsertSkillIndex(row: SkillIndexRow): void {
    this.stmtUpsertSkillIndex.run(
      row.skill_name,
      row.description,
      row.instructions_summary,
      row.keywords,
      row.embedding,
      row.updated_at,
    );
  }

  getAllSkillIndex(): SkillIndexRow[] {
    return this.stmtGetAllSkillIndex.all() as SkillIndexRow[];
  }

  deleteSkillIndex(name: string): void {
    this.stmtDeleteSkillIndex.run(name);
  }

  clearSkillIndex(): void {
    this.stmtClearSkillIndex.run();
  }

  // --- Context Index CRUD ---

  upsertContextIndex(row: ContextIndexRow): void {
    this.stmtUpsertContextIndex.run(
      row.dir_path,
      row.overview_content,
      row.content_hash,
      row.keywords,
      row.embedding,
      row.embedding_signature,
      row.embedding_dimensions,
      row.embedding_status,
      row.updated_at,
    );
  }

  getAllContextIndex(): ContextIndexRow[] {
    return this.stmtGetAllContextIndex.all() as ContextIndexRow[];
  }

  deleteContextIndex(dirPath: string): void {
    this.stmtDeleteContextIndex.run(dirPath);
  }

  clearContextIndex(): void {
    this.stmtClearContextIndex.run();
  }

  replaceContextIndex(rows: ContextIndexRow[]): void {
    this.db.transaction(() => {
      this.stmtClearContextIndex.run();
      for (const row of rows) this.upsertContextIndex(row);
    })();
  }

  // --- Memory Index CRUD ---

  upsertMemoryIndex(row: MemoryIndexRow): void {
    this.stmtUpsertMemoryIndex.run(
      row.id,
      row.source_path,
      row.source_kind,
      row.chunk_index,
      row.content,
      row.file_hash,
      row.chunk_hash,
      row.keywords,
      row.embedding,
      row.embedding_signature,
      row.embedding_dimensions,
      row.embedding_status,
      row.updated_at,
    );
  }

  getAllMemoryIndex(): MemoryIndexRow[] {
    return this.stmtGetAllMemoryIndex.all() as MemoryIndexRow[];
  }

  getMemoryIndexBySourcePath(sourcePath: string): MemoryIndexRow[] {
    return this.stmtGetMemoryIndexBySourcePath.all(sourcePath) as MemoryIndexRow[];
  }

  deleteMemoryIndexBySourcePath(sourcePath: string): void {
    this.stmtDeleteMemoryIndexBySourcePath.run(sourcePath);
  }

  clearMemoryIndex(): void {
    this.stmtClearMemoryIndex.run();
  }

  getMemoryIndexCount(): number {
    const row = this.stmtCountMemoryIndex.get() as { count: number };
    return row.count;
  }

  replaceMemoryIndexForSource(sourcePath: string, rows: MemoryIndexRow[]): void {
    this.db.transaction(() => {
      this.stmtDeleteMemoryIndexBySourcePath.run(sourcePath);
      for (const row of rows) this.upsertMemoryIndex(row);
    })();
  }

  replaceAllMemoryIndex(rows: MemoryIndexRow[]): void {
    this.db.transaction(() => {
      this.stmtClearMemoryIndex.run();
      for (const row of rows) this.upsertMemoryIndex(row);
    })();
  }

  // --- Session Approval CRUD ---

  createSessionApproval(sessionId: string, data: {
    toolName: string;
    params: Record<string, unknown>;
    rule: unknown;
    message: string;
  }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.stmtInsertSessionApproval.run(
      id,
      sessionId,
      data.toolName,
      JSON.stringify(data.params),
      data.rule ? JSON.stringify(data.rule) : null,
      data.message,
      now,
    );
    return id;
  }

  getSessionPendingApproval(sessionId: string): SessionApprovalRecord | null {
    return (this.stmtGetPendingApproval.get(sessionId) as SessionApprovalRecord) ?? null;
  }

  approveSessionApproval(id: string): void {
    const now = new Date().toISOString();
    this.stmtResolveApproval.run(id, "approved", now);
  }

  rejectSessionApproval(id: string): void {
    const now = new Date().toISOString();
    this.stmtResolveApproval.run(id, "rejected", now);
  }

  getApprovedCallKeys(sessionId: string): string[] {
    const rows = this.stmtGetApprovedCallKeys.all(sessionId) as Array<{ tool_name: string; params: string }>;
    return rows.map(r => `${r.tool_name}:${r.params}`);
  }

  // --- Lifecycle ---

  close(): void {
    this.db.close();
  }
}
