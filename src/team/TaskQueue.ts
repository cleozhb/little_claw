import type { Database } from "../db/Database.ts";
import type { RegisteredAgent } from "./AgentRegistry.ts";

export type TaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  assignedTo?: string;
  createdBy: string;
  dependsOn: string[];
  blocks: string[];
  approvalPrompt?: string;
  approvalData?: unknown;
  approvalResponse?: string;
  result?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
  tags: string[];
  project?: string;
  channelId?: string;
  sourceMessageId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  dueAt?: string;
}

export interface TaskLog {
  id: string;
  taskId: string;
  agentName?: string;
  eventType: string;
  content?: string;
  createdAt: string;
}

export interface CreateTaskParams {
  title: string;
  description: string;
  priority?: number;
  tags?: string[];
  project?: string;
  channelId?: string;
  sourceMessageId?: string;
  createdBy: string;
  assignedTo?: string;
  dependsOn?: string[];
  dueAt?: string;
  maxRetries?: number;
}

export interface ListTasksFilter {
  status?: TaskStatus;
  assignedTo?: string;
  project?: string;
  tags?: string[];
  limit?: number;
}

interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  assigned_to: string | null;
  created_by: string;
  depends_on: string;
  blocks: string;
  approval_prompt: string | null;
  approval_data: string | null;
  approval_response: string | null;
  result: string | null;
  error: string | null;
  retry_count: number;
  max_retries: number;
  tags: string;
  project: string | null;
  channel_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  due_at: string | null;
}

interface TaskLogRow {
  id: string;
  task_id: string;
  agent_name: string | null;
  event_type: string;
  content: string | null;
  created_at: string;
}

export class TaskQueue {
  private db: Database;

  private stmtInsertTask;
  private stmtGetTask;
  private stmtListTasks;
  private stmtUpdateTask;
  private stmtInsertLog;
  private stmtGetLogs;
  private stmtCountActiveForAgent;

  constructor(db: Database) {
    this.db = db;
    this.initTables();

    // 复用主 Database 持有的 SQLite 连接，确保任务表和会话等数据落在同一个库里。
    const sqlite = this.getSQLite();

    this.stmtInsertTask = sqlite.prepare(`
      INSERT INTO tasks (
        id, title, description, status, priority, assigned_to, created_by,
        depends_on, blocks, approval_prompt, approval_data, approval_response,
        result, error, retry_count, max_retries, tags, project, channel_id,
        source_message_id, created_at, updated_at, started_at, completed_at, due_at
      )
      VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
        ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25
      )
    `);

    this.stmtGetTask = sqlite.prepare(`SELECT * FROM tasks WHERE id = ?1`);
    this.stmtListTasks = sqlite.prepare(
      `SELECT * FROM tasks ORDER BY priority DESC, created_at ASC`,
    );
    this.stmtUpdateTask = sqlite.prepare(`
      UPDATE tasks SET
        title = ?2,
        description = ?3,
        status = ?4,
        priority = ?5,
        assigned_to = ?6,
        created_by = ?7,
        depends_on = ?8,
        blocks = ?9,
        approval_prompt = ?10,
        approval_data = ?11,
        approval_response = ?12,
        result = ?13,
        error = ?14,
        retry_count = ?15,
        max_retries = ?16,
        tags = ?17,
        project = ?18,
        channel_id = ?19,
        source_message_id = ?20,
        created_at = ?21,
        updated_at = ?22,
        started_at = ?23,
        completed_at = ?24,
        due_at = ?25
      WHERE id = ?1
    `);
    this.stmtInsertLog = sqlite.prepare(`
      INSERT INTO task_logs (id, task_id, agent_name, event_type, content, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `);
    this.stmtGetLogs = sqlite.prepare(
      `SELECT * FROM task_logs WHERE task_id = ?1 ORDER BY created_at ASC`,
    );
    this.stmtCountActiveForAgent = sqlite.prepare(`
      SELECT COUNT(*) as count
      FROM tasks
      WHERE assigned_to = ?1
        AND status IN ('assigned', 'running', 'awaiting_approval', 'approved', 'rejected')
    `);
  }

  createTask(params: CreateTaskParams): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: crypto.randomUUID(),
      title: params.title,
      description: params.description,
      status: params.assignedTo ? "assigned" : "pending",
      priority: params.priority ?? 0,
      assignedTo: params.assignedTo,
      createdBy: params.createdBy,
      dependsOn: params.dependsOn ?? [],
      blocks: [],
      retryCount: 0,
      maxRetries: params.maxRetries ?? 2,
      tags: params.tags ?? [],
      project: params.project,
      channelId: params.channelId,
      sourceMessageId: params.sourceMessageId,
      createdAt: now,
      updatedAt: now,
      dueAt: params.dueAt,
    };

    // createTask 是任务生命周期的入口；创建任务本身也必须写日志，方便重启后追溯来源。
    this.insertTask(task);
    this.addLog(task.id, "created", {
      agentName: params.createdBy,
      content: `Task created with status ${task.status}.`,
    });

    if (params.assignedTo) {
      this.addLog(task.id, "assigned", {
        agentName: params.assignedTo,
        content: `Task assigned to ${params.assignedTo}.`,
      });
    }

    return task;
  }

  getTask(id: string): Task | null {
    const row = this.stmtGetTask.get(id) as TaskRow | undefined;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(filter: ListTasksFilter = {}): Task[] {
    let tasks = (this.stmtListTasks.all() as TaskRow[]).map((row) => this.rowToTask(row));

    if (filter.status) {
      tasks = tasks.filter((task) => task.status === filter.status);
    }
    if (filter.assignedTo) {
      tasks = tasks.filter((task) => task.assignedTo === filter.assignedTo);
    }
    if (filter.project) {
      tasks = tasks.filter((task) => task.project === filter.project);
    }
    if (filter.tags && filter.tags.length > 0) {
      tasks = tasks.filter((task) => hasTagOverlap(task.tags, filter.tags!));
    }

    return tasks.slice(0, filter.limit ?? tasks.length);
  }

  getTaskLogs(taskId: string): TaskLog[] {
    return (this.stmtGetLogs.all(taskId) as TaskLogRow[]).map((row) => ({
      id: row.id,
      taskId: row.task_id,
      agentName: row.agent_name ?? undefined,
      eventType: row.event_type,
      content: row.content ?? undefined,
      createdAt: row.created_at,
    }));
  }

  assignTask(taskId: string, agentName: string): Task {
    const task = this.requireTask(taskId);
    this.assertStatus(task, ["pending"], "assign");
    // 分配前检查依赖，避免 Worker 拿到尚不可执行的任务。
    this.assertDependenciesCompleted(task);

    task.status = "assigned";
    task.assignedTo = agentName;
    this.saveTask(task);
    this.addLog(task.id, "assigned", {
      agentName,
      content: `Task assigned to ${agentName}.`,
    });
    return task;
  }

  startTask(taskId: string, agentName?: string): Task {
    const task = this.requireTask(taskId);
    this.assertStatus(task, ["assigned", "approved", "rejected"], "start");

    task.status = "running";
    task.assignedTo = agentName ?? task.assignedTo;
    task.startedAt ??= new Date().toISOString();
    this.saveTask(task);
    this.addLog(task.id, "started", {
      agentName: task.assignedTo,
      content: "Task started.",
    });
    return task;
  }

  requestApproval(taskId: string, params: { prompt: string; data?: unknown; agentName?: string }): Task {
    const task = this.requireTask(taskId);
    this.assertStatus(task, ["running"], "request approval");

    // 审批是任务状态的一部分，不是普通聊天消息；prompt/data/response 都要持久化。
    task.status = "awaiting_approval";
    task.approvalPrompt = params.prompt;
    task.approvalData = params.data;
    task.approvalResponse = undefined;
    this.saveTask(task);
    this.addLog(task.id, "approval_requested", {
      agentName: params.agentName ?? task.assignedTo,
      content: params.prompt,
    });
    return task;
  }

  approveTask(taskId: string, response: string, agentName?: string): Task {
    const task = this.requireTask(taskId);
    this.assertStatus(task, ["awaiting_approval"], "approve");

    task.status = "approved";
    task.approvalResponse = response;
    this.saveTask(task);
    this.addLog(task.id, "approved", {
      agentName,
      content: response,
    });
    return task;
  }

  rejectTask(taskId: string, response: string, agentName?: string): Task {
    const task = this.requireTask(taskId);
    this.assertStatus(task, ["awaiting_approval"], "reject");

    // rejected 与 failed 不同：它表示人类拒绝当前方案，Worker 后续可以改方案后继续运行。
    task.status = "rejected";
    task.approvalResponse = response;
    this.saveTask(task);
    this.addLog(task.id, "rejected", {
      agentName,
      content: response,
    });
    return task;
  }

  completeTask(taskId: string, result: string, agentName?: string): Task {
    const task = this.requireTask(taskId);
    this.assertStatus(task, ["running"], "complete");

    task.status = "completed";
    task.result = result;
    task.completedAt = new Date().toISOString();
    this.saveTask(task);
    this.addLog(task.id, "completed", {
      agentName: agentName ?? task.assignedTo,
      content: result,
    });
    return task;
  }

  failTask(taskId: string, error: string, agentName?: string): Task {
    const task = this.requireTask(taskId);
    this.assertStatus(task, ["running"], "fail");

    const failedBy = agentName ?? task.assignedTo;
    task.retryCount += 1;
    // 失败未超过上限时回到 pending，等待后续重新分配；达到上限才进入最终 failed。
    task.error = error;
    task.status = task.retryCount < task.maxRetries ? "pending" : "failed";
    if (task.status === "pending") {
      task.assignedTo = undefined;
      task.startedAt = undefined;
    } else {
      task.completedAt = new Date().toISOString();
    }

    this.saveTask(task);
    this.addLog(task.id, "failed", {
      agentName: failedBy,
      content: error,
    });

    if (task.status === "pending") {
      this.addLog(task.id, "retry_scheduled", {
        content: `Retry ${task.retryCount} of ${task.maxRetries}.`,
      });
    }

    return task;
  }

  cancelTask(taskId: string, reason?: string, agentName?: string): Task {
    const task = this.requireTask(taskId);
    this.assertStatus(
      task,
      ["pending", "assigned", "running", "awaiting_approval", "approved", "rejected"],
      "cancel",
    );

    task.status = "cancelled";
    task.error = reason ?? task.error;
    task.completedAt = new Date().toISOString();
    this.saveTask(task);
    this.addLog(task.id, "cancelled", {
      agentName: agentName ?? task.assignedTo,
      content: reason,
    });
    return task;
  }

  delegateTask(
    parentTaskId: string,
    params: Omit<CreateTaskParams, "createdBy"> & { createdBy?: string },
  ): Task {
    const parent = this.requireTask(parentTaskId);
    // 委派会创建子任务，并把子任务 ID 写入父任务 blocks，保留任务拆解关系。
    const child = this.createTask({
      ...params,
      createdBy: params.createdBy ?? parent.assignedTo ?? parent.createdBy,
    });

    parent.blocks = unique([...parent.blocks, child.id]);
    this.saveTask(parent);
    this.addLog(parent.id, "delegated", {
      agentName: parent.assignedTo,
      content: `Delegated child task ${child.id}.`,
    });
    return child;
  }

  addProgress(taskId: string, content: string, agentName?: string): void {
    const task = this.requireTask(taskId);
    this.addLog(task.id, "progress", {
      agentName: agentName ?? task.assignedTo,
      content,
    });
  }

  getPendingForAgent(agent: RegisteredAgent, limit?: number): Task[] {
    const activeCount = this.countActiveForAgent(agent.config.name);
    const availableSlots = agent.config.max_concurrent_tasks - activeCount;
    if (availableSlots <= 0) return [];

    // 候选任务按 Agent 的 task_tags、依赖完成情况和并发余量筛选，TaskQueue 不调用 LLM。
    const tagSet = agent.config.task_tags;
    const candidates = this.listTasks({ status: "pending" }).filter((task) => {
      if (task.assignedTo && task.assignedTo !== agent.config.name) return false;
      if (task.tags.length > 0 && !hasTagOverlap(task.tags, tagSet)) return false;
      return this.dependenciesCompleted(task);
    });

    return candidates.slice(0, Math.min(limit ?? availableSlots, availableSlots));
  }

  private initTables(): void {
    const sqlite = this.getSQLite();
    sqlite.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        assigned_to TEXT,
        created_by TEXT NOT NULL,
        depends_on TEXT DEFAULT '[]',
        blocks TEXT DEFAULT '[]',
        approval_prompt TEXT,
        approval_data TEXT,
        approval_response TEXT,
        result TEXT,
        error TEXT,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 2,
        tags TEXT DEFAULT '[]',
        project TEXT,
        channel_id TEXT,
        source_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        due_at TEXT
      )
    `);

    sqlite.run(`
      CREATE TABLE IF NOT EXISTS task_logs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_name TEXT,
        event_type TEXT NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);

    sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)`);
    sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks (assigned_to)`);
    sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project)`);
    sqlite.run(`CREATE INDEX IF NOT EXISTS idx_task_logs_task_time ON task_logs (task_id, created_at)`);
  }

  private getSQLite() {
    return (this.db as any).db;
  }

  private insertTask(task: Task): void {
    this.stmtInsertTask.run(...this.taskParams(task));
  }

  private saveTask(task: Task): void {
    // 所有状态修改最终都走这里，统一刷新 updatedAt 后写回数据库。
    task.updatedAt = new Date().toISOString();
    this.stmtUpdateTask.run(...this.taskParams(task));
  }

  private taskParams(task: Task): unknown[] {
    return [
      task.id,
      task.title,
      task.description,
      task.status,
      task.priority,
      task.assignedTo ?? null,
      task.createdBy,
      JSON.stringify(task.dependsOn),
      JSON.stringify(task.blocks),
      task.approvalPrompt ?? null,
      task.approvalData === undefined ? null : JSON.stringify(task.approvalData),
      task.approvalResponse ?? null,
      task.result ?? null,
      task.error ?? null,
      task.retryCount,
      task.maxRetries,
      JSON.stringify(task.tags),
      task.project ?? null,
      task.channelId ?? null,
      task.sourceMessageId ?? null,
      task.createdAt,
      task.updatedAt,
      task.startedAt ?? null,
      task.completedAt ?? null,
      task.dueAt ?? null,
    ];
  }

  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assignedTo: row.assigned_to ?? undefined,
      createdBy: row.created_by,
      dependsOn: parseStringArray(row.depends_on),
      blocks: parseStringArray(row.blocks),
      approvalPrompt: row.approval_prompt ?? undefined,
      approvalData: row.approval_data === null ? undefined : JSON.parse(row.approval_data),
      approvalResponse: row.approval_response ?? undefined,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      tags: parseStringArray(row.tags),
      project: row.project ?? undefined,
      channelId: row.channel_id ?? undefined,
      sourceMessageId: row.source_message_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      dueAt: row.due_at ?? undefined,
    };
  }

  private addLog(
    taskId: string,
    eventType: string,
    options: { agentName?: string; content?: string } = {},
  ): void {
    this.stmtInsertLog.run(
      crypto.randomUUID(),
      taskId,
      options.agentName ?? null,
      eventType,
      options.content ?? null,
      new Date().toISOString(),
    );
  }

  private requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    return task;
  }

  private assertStatus(task: Task, allowed: TaskStatus[], action: string): void {
    // 状态机守卫：只允许文档定义的流转路径，避免调用方随意跳状态。
    if (!allowed.includes(task.status)) {
      throw new Error(
        `Cannot ${action} task ${task.id} from status ${task.status}. Allowed: ${allowed.join(", ")}.`,
      );
    }
  }

  private assertDependenciesCompleted(task: Task): void {
    if (!this.dependenciesCompleted(task)) {
      throw new Error(`Task ${task.id} has incomplete dependencies.`);
    }
  }

  private dependenciesCompleted(task: Task): boolean {
    // 缺失的依赖按未完成处理，防止任务引用错误时被提前执行。
    return task.dependsOn.every((dependencyId) => {
      const dependency = this.getTask(dependencyId);
      return dependency?.status === "completed";
    });
  }

  private countActiveForAgent(agentName: string): number {
    const row = this.stmtCountActiveForAgent.get(agentName) as { count: number };
    return row.count;
  }
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function hasTagOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((tag) => rightSet.has(tag));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
