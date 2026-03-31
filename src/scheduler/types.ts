// --- Scheduler Types ---

export interface CronJob {
  id: string;
  name: string;
  cronExpr: string;       // 标准 cron 表达式，如 "0 8 * * *"
  prompt: string;          // 触发时发给 Agent 的消息
  sessionId: string;       // 在哪个 session 里执行
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface WatcherDef {
  id: string;
  name: string;
  checkCommand: string;    // 用 shell 执行的检查命令
  condition: string;       // 自然语言描述的条件，让 LLM 判断是否满足
  prompt: string;          // 条件满足时发给 Agent 的消息
  intervalMs: number;      // 检查间隔，默认 60000
  cooldownMs: number;      // 冷却期，默认 300000（5 分钟），冷却期内不重复触发
  sessionId: string;
  enabled: boolean;
  createdAt: string;
  lastCheckAt?: string;
  lastTriggeredAt?: string;
}

export type SchedulerEvent =
  | { type: "cron_trigger"; job: CronJob }
  | { type: "watcher_trigger"; watcher: WatcherDef; checkOutput: string };
