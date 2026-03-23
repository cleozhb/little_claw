import { Database as SQLiteDatabase } from "bun:sqlite";

// --- Record Types ---

export interface Session {
  id: string;
  title: string | null;
  system_prompt: string | null;
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
  private stmtUpdateSessionTimestamp;
  private stmtInsertMessage;
  private stmtGetMessages;
  private stmtGetMessageCount;
  private stmtInsertToolResult;
  private stmtGetToolResults;

  constructor(dbPath: string) {
    this.db = new SQLiteDatabase(dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");

    this.initTables();

    // Prepare all statements
    this.stmtInsertSession = this.db.prepare(
      `INSERT INTO sessions (id, title, system_prompt, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    );

    this.stmtGetSession = this.db.prepare(
      `SELECT * FROM sessions WHERE id = ?1`
    );

    this.stmtListSessions = this.db.prepare(
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
  }

  private initTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        title        TEXT,
        system_prompt TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      )
    `);

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
  }

  // --- Session CRUD ---

  createSession(systemPrompt?: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: crypto.randomUUID(),
      title: null,
      system_prompt: systemPrompt ?? null,
      created_at: now,
      updated_at: now,
    };

    this.stmtInsertSession.run(
      session.id,
      session.title,
      session.system_prompt,
      session.created_at,
      session.updated_at
    );

    return session;
  }

  getSession(id: string): Session | null {
    return (this.stmtGetSession.get(id) as Session) ?? null;
  }

  listSessions(limit: number = 20): Session[] {
    return this.stmtListSessions.all(limit) as Session[];
  }

  deleteSession(id: string): void {
    // Delete related data first (respect foreign keys)
    this.stmtDeleteSessionToolResults.run(id);
    this.stmtDeleteSessionMessages.run(id);
    this.stmtDeleteSession.run(id);
  }

  updateSessionTitle(id: string, title: string): void {
    const now = new Date().toISOString();
    this.stmtUpdateSessionTitle.run(id, title, now);
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

  // --- Lifecycle ---

  close(): void {
    this.db.close();
  }
}
