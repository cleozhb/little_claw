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
  private stmtDeleteSession;
  private stmtDeleteSessionMessages;
  private stmtDeleteSessionToolResults;
  private stmtUpdateSessionTitle;
  private stmtUpdateSessionSummary;
  private stmtUpdateSessionTimestamp;
  private stmtInsertMessage;
  private stmtGetMessages;
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
  private stmtInsertSessionApproval;
  private stmtGetPendingApproval;
  private stmtResolveApproval;
  private stmtGetApprovedCallKeys;
  private stmtDeleteSessionApprovals;
  private stmtUpdateToolResult;

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
      `SELECT * FROM messages WHERE session_id = ?1 ORDER BY created_at ASC`
    );

    this.stmtGetMessageCount = this.db.prepare(
      `SELECT COUNT(*) as count FROM messages WHERE session_id = ?1`
    );

    this.stmtInsertToolResult = this.db.prepare(
      `INSERT INTO tool_results (id, session_id, message_id, tool_use_id, tool_name, tool_input, tool_output, is_error, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    );

    this.stmtGetToolResults = this.db.prepare(
      `SELECT * FROM tool_results WHERE message_id = ?1 ORDER BY created_at ASC`
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
      `INSERT OR REPLACE INTO context_index (dir_path, overview_content, content_hash, keywords, embedding, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
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
        updated_at       TEXT NOT NULL
      )
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
      CREATE INDEX IF NOT EXISTS idx_session_approvals_session_status
        ON session_approvals (session_id, status)
    `);
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

    this.stmtInsertSession.run(
      session.id,
      session.title,
      session.system_prompt,
      session.last_summary,
      session.mode,
      session.created_at,
      session.updated_at
    );

    return session;
  }

  getSession(id: string): Session | null {
    return (this.stmtGetSession.get(id) as Session) ?? null;
  }

  listSessions(limit: number = 100): Session[] {
    return this.stmtListSessions.all(limit) as Session[];
  }

  deleteSession(id: string): void {
    this.db.transaction(() => {
      // Delete related data first (respect foreign keys)
      this.stmtDeleteSessionApprovals.run(id);
      this.stmtDeleteSessionToolResults.run(id);
      this.stmtDeleteSessionMessages.run(id);
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
