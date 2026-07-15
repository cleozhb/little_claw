import { join, relative } from "node:path";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { appendFile, open, rename, unlink } from "node:fs/promises";
import type { Message } from "../types/message.ts";
import { systemAppClock, type AppClock } from "../utils/AppClock.ts";

export type MemorySourceKind = "memory" | "inbox" | "daily";

export interface MemoryFileRef {
  path: string;
  absolutePath: string;
  kind: MemorySourceKind;
}

export type MemoryUpdateDecision<TStatus extends string = string> =
  | { action: "write"; content: string; status: TStatus }
  | { action: "keep"; status: TStatus };

export interface MemoryUpdateResult<TStatus extends string = string> {
  changed: boolean;
  status: TStatus;
}

const MEMORY_TEMPLATE = `# Memory

Long-term personal memory and durable collaboration preferences live here.
`;

const INBOX_TEMPLATE = `# Memory Inbox

Unsorted memory candidates live here until they are promoted or discarded.
`;

export class MemoryStore {
  private baseDir: string;
  private memoryDir: string;
  private dailyDir: string;
  private logsDir: string;
  private conversationLogsDir: string;
  private fileQueues = new Map<string, Promise<void>>();
  private clock: AppClock;

  constructor(baseDir?: string, clock: AppClock = systemAppClock) {
    this.baseDir = baseDir ?? join(process.env.HOME ?? "~", ".little_claw");
    this.memoryDir = join(this.baseDir, "memory");
    this.dailyDir = join(this.memoryDir, "daily");
    this.logsDir = join(this.baseDir, "logs");
    this.conversationLogsDir = join(this.logsDir, "conversations");
    this.clock = clock;
  }

  async initialize(): Promise<void> {
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.dailyDir, { recursive: true });
    mkdirSync(this.conversationLogsDir, { recursive: true });

    await this.migrateLegacyFiles();
    await this.ensureFile(join(this.memoryDir, "MEMORY.md"), MEMORY_TEMPLATE);
    await this.ensureFile(join(this.memoryDir, "inbox.md"), INBOX_TEMPLATE);
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getMemoryDir(): string {
    return this.memoryDir;
  }

  getLogsDir(): string {
    return this.logsDir;
  }

  getConversationLogsDir(): string {
    return this.conversationLogsDir;
  }

  async readMemory(filePath: string): Promise<string | null> {
    const resolved = this.resolveMemoryPath(filePath);
    return this.readFileIfExists(resolved);
  }

  async writeMemory(
    filePath: string,
    content: string,
    mode: "append" | "overwrite" = "append",
  ): Promise<boolean> {
    const resolved = this.resolveMemoryPath(filePath);
    if (mode === "append") return this.appendResolved(resolved, content);
    return this.overwriteResolved(resolved, content);
  }

  async writeDailyNote(content: string, now = this.clock.now()): Promise<{ path: string; changed: boolean }> {
    const path = `daily/${this.getTodayDate(now)}.md`;
    const changed = await this.writeMemory(path, content, "append");
    return { path, changed };
  }

  async appendMemoryOnce(
    filePath: string,
    content: string,
    marker: string,
  ): Promise<{ path: string; status: "written" | "already_written" }> {
    const resolved = this.resolveMemoryPath(filePath);
    return this.runFileMutation(resolved, async () => {
      const existing = await this.readFileIfExists(resolved);
      if (existing?.includes(marker)) {
        return { path: filePath, status: "already_written" as const };
      }
      await this.appendResolvedUnlocked(resolved, content, existing);
      return { path: filePath, status: "written" as const };
    });
  }

  async updateMemory<TStatus extends string>(
    filePath: string,
    updater: (current: string) => Promise<MemoryUpdateDecision<TStatus>>,
  ): Promise<MemoryUpdateResult<TStatus>> {
    const resolved = this.resolveMemoryPath(filePath);
    return this.runFileMutation(resolved, async () => {
      const current = (await this.readFileIfExists(resolved)) ?? "";
      const decision = await updater(current);
      if (decision.action === "keep") {
        return { changed: false, status: decision.status };
      }
      if (decision.content === current) {
        return { changed: false, status: decision.status };
      }
      await this.overwriteResolvedUnlocked(resolved, decision.content);
      return { changed: true, status: decision.status };
    });
  }

  appendConversationLog(
    sessionId: string,
    sessionTitle: string | null,
    channelId: string | undefined,
    messages: Message[],
  ): void {
    if (messages.length === 0) return;
    mkdirSync(this.conversationLogsDir, { recursive: true });

    const now = this.clock.now();
    const filePath = join(this.conversationLogsDir, `${this.getTodayDate(now)}.jsonl`);
    const ts = now.toISOString();
    const lines = messages.map((msg) => {
      const record = {
        session: { id: sessionId, title: sessionTitle, channelId: channelId ?? null },
        ts,
        role: msg.role,
        content: msg.content,
      };
      return JSON.stringify(record);
    });

    appendFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  }

  async listIndexableFiles(): Promise<MemoryFileRef[]> {
    const files: MemoryFileRef[] = [];
    await this.addIfExists(files, "MEMORY.md", "memory");
    await this.addIfExists(files, "inbox.md", "inbox");

    const glob = new Bun.Glob("*.md");
    for await (const entry of glob.scan({ cwd: this.dailyDir, onlyFiles: true })) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(entry)) {
        const path = `daily/${entry}`;
        files.push({
          path,
          absolutePath: join(this.memoryDir, path),
          kind: "daily",
        });
      }
    }

    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  getTodayDate(date = this.clock.now()): string {
    return this.clock.formatDate(date);
  }

  private async addIfExists(files: MemoryFileRef[], path: string, kind: MemorySourceKind): Promise<void> {
    const absolutePath = join(this.memoryDir, path);
    if (await Bun.file(absolutePath).exists()) {
      files.push({ path, absolutePath, kind });
    }
  }

  private async migrateLegacyFiles(): Promise<void> {
    await this.copyIfMissing(
      join(this.baseDir, "context-hub", "0-identity", "profile.md"),
      join(this.memoryDir, "MEMORY.md"),
    );
    await this.copyIfMissing(
      join(this.baseDir, "context-hub", "1-inbox", "inbox.md"),
      join(this.memoryDir, "inbox.md"),
    );

    const mdGlob = new Bun.Glob("*.md");
    for await (const entry of mdGlob.scan({ cwd: this.memoryDir, onlyFiles: true })) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(entry)) {
        await this.copyIfMissing(join(this.memoryDir, entry), join(this.dailyDir, entry));
      }
    }

    const jsonlGlob = new Bun.Glob("*.jsonl");
    for await (const entry of jsonlGlob.scan({ cwd: this.memoryDir, onlyFiles: true })) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)) {
        await this.copyIfMissing(
          join(this.memoryDir, entry),
          join(this.conversationLogsDir, entry),
        );
      }
    }
  }

  private async copyIfMissing(source: string, target: string): Promise<void> {
    if (existsSync(target)) return;
    const file = Bun.file(source);
    if (!(await file.exists())) return;
    const dir = target.substring(0, target.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    await Bun.write(target, await file.text());
  }

  private resolveMemoryPath(filePath: string): string {
    if (filePath.startsWith("context-hub/")) {
      throw new Error("memory_read only supports memory/ files. Use context_read for context-hub paths.");
    }

    const cleaned = filePath.startsWith("memory/")
      ? filePath.slice("memory/".length)
      : filePath;

    if (cleaned.includes("..")) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }

    if (filePath.startsWith("/")) {
      const absoluteRel = relative(this.memoryDir, filePath);
      if (absoluteRel.startsWith("..") || absoluteRel.startsWith("/") || absoluteRel === "") {
        throw new Error(`Path must be within ${this.memoryDir}, got: ${filePath}`);
      }
      return filePath;
    }

    const resolved = join(this.memoryDir, cleaned);
    const rel = relative(this.memoryDir, resolved);
    if (rel.startsWith("..") || rel === "" || rel.startsWith("/")) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }
    return resolved;
  }

  private async readFileIfExists(path: string): Promise<string | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return file.text();
  }

  private async ensureFile(path: string, content: string): Promise<void> {
    if (!existsSync(path)) {
      await Bun.write(path, content);
    }
  }

  private async appendResolved(resolved: string, content: string): Promise<boolean> {
    return this.runFileMutation(resolved, async () => {
      const existing = await this.readFileIfExists(resolved);
      return this.appendResolvedUnlocked(resolved, content, existing);
    });
  }

  private async appendResolvedUnlocked(
    resolved: string,
    content: string,
    existing: string | null,
  ): Promise<boolean> {
    if (!content) return false;
    const dir = resolved.substring(0, resolved.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(resolved, `${separator}${content}`, "utf8");
    return true;
  }

  private async overwriteResolved(resolved: string, content: string): Promise<boolean> {
    return this.runFileMutation(resolved, async () => {
      const existing = await this.readFileIfExists(resolved);
      if ((existing ?? "") === content) return false;
      await this.overwriteResolvedUnlocked(resolved, content);
      return true;
    });
  }

  private async overwriteResolvedUnlocked(resolved: string, content: string): Promise<void> {
    const dir = resolved.substring(0, resolved.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const temp = `${resolved}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temp, "wx");
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, resolved);
    } catch (err) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw err;
    }
  }

  private async runFileMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.fileQueues.get(path) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    this.fileQueues.set(path, tail);
    try {
      return await run;
    } finally {
      if (this.fileQueues.get(path) === tail) this.fileQueues.delete(path);
    }
  }
}
