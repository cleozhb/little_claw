# Team Scheduled Tasks Plan

这份计划描述如何把现有 chat 模式的 Cron/Event Watcher 能力接入 Lovely Octopus team 模式。

核心结论：

- Team 模式下，定时任务必须有明确执行主体，也就是绑定到某个 Agent。
- 旧 scheduler 的计时、持久化、触发回调可以复用。
- 旧的 `sessionId -> SessionRouter -> scheduled stream` 执行路径不适合 team 模式。
- Team 模式的触发结果应该落为 `TaskQueue` 任务，再由 `AgentWorker` 执行。
- 前端结果展示应复用 Tasks、Channels、Agent DM、Project Channel；Calendar 负责展示计划和历史索引。

---

## 1. 目标

实现 team-native scheduled tasks：

```text
cron/watch trigger
  -> TeamScheduleAdapter
  -> TaskQueue.createTask({ assignedTo: agentName, ... })
  -> AgentWorker
  -> task_logs + team_messages + project/channel result
```

最终用户应该能做到：

- 在某个 Agent 配置中声明自动任务。
- 在 Mission Control 的 Calendar 页面看到所有 team scheduled tasks。
- 定时触发后，在 Tasks 页面看到一张普通 team task 卡片。
- Agent 完成后，在项目频道或 Agent DM 中看到执行结果。
- 能启停、查看 last run、next run、最近失败、最近触发产生的 task。

---

## 2. 设计原则

### 2.1 Agent 是执行主体

Team scheduled task 不应该只绑定 chat session。它应该绑定：

- `agentName`：必须字段，执行任务的 Agent。
- `project`：可选字段，任务结果归属的项目频道。
- `channelId`：可选字段，结果写入哪个 team channel。
- `tags`：可选字段，用于任务分类和 Agent 匹配。

如果用户想让系统自行拆解任务，可以绑定到 `coordinator`，再由 Coordinator 创建子任务。

### 2.2 YAML 是默认声明，DB 是运行真相

`agent.yaml` 中的 `cron_jobs` 适合作为声明式默认配置，但运行状态不能只靠 YAML。

YAML 适合存：

- 这个 Agent 拥有哪些计划任务。
- 默认 cron 表达式、prompt、project、tags。

DB 必须存：

- schedule id。
- enabled/disabled。
- lastRunAt/nextRunAt。
- lastTaskId。
- lastStatus。
- failure count / lastError。
- createdAt/updatedAt。

这样 UI 才能改启停状态，服务重启后也能恢复运行历史。

### 2.3 触发不直接跑 LLM

旧 chat 模式触发后直接调用 `sessionRouter.handleChat(...)`。Team 模式不要这样做。

Team 模式触发后只创建任务：

```ts
taskQueue.createTask({
  title: `[scheduled] ${schedule.name}`,
  description: schedule.prompt,
  createdBy: `scheduler:${schedule.id}`,
  assignedTo: schedule.agentName,
  project: schedule.project,
  channelId: schedule.channelId,
  tags: ["scheduled", ...schedule.tags],
  maxRetries: schedule.maxRetries,
});
```

后续执行交给现有 `AgentWorker`。这样审批、重试、取消、结果归档都自动复用 team 机制。

---

## 3. 现状判断

### 3.1 可复用部分

现有 `CronScheduler` 已经具备：

- cron 表达式解析。
- SQLite 持久化。
- `lastRunAt` / `nextRunAt`。
- enable/disable。
- `onTrigger()` 回调。

现有 `EventWatcher` 已经具备：

- 按 interval 执行 shell check command。
- exit code 0 触发。
- cooldown 防重复。
- `lastCheckAt` / `lastTriggeredAt`。
- `onTrigger()` 回调。

### 3.2 不能直接复用部分

当前 scheduler 类型仍以 `sessionId` 为执行归属：

```ts
export interface CronJob {
  sessionId: string;
}

export interface WatcherDef {
  sessionId: string;
}
```

server 触发逻辑目前是：

```text
scheduler trigger
  -> gateway.sendToSession(scheduled_run_start)
  -> sessionRouter.handleChat(sessionId, prompt)
  -> gateway.sendToSession(source: scheduled)
```

这条路径适合 chat，不适合 team。Team 模式需要把触发转换成 `TaskQueue` 任务。

### 3.3 Team 侧已有基础

Team 模式已经有：

- `AgentRegistry`：加载 agent.yaml / SOUL.md / AGENTS.md。
- `TaskQueue`：任务状态机、审批、重试、task logs。
- `AgentWorker`：轮询任务并执行。
- `TeamMessageStore`：团队消息事实表。
- Mission Control：Tasks / Channels / Team 页面和 WebSocket 增量更新。

因此新增功能应尽量做适配层，而不是重写执行循环。

---

## 4. 数据模型

建议新增 team schedule 表，而不是直接扩展旧 `cron_jobs.session_id`。

### 4.1 `team_schedules`

```sql
CREATE TABLE team_schedules (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                 -- "agent_yaml" | "ui" | "migration"
  source_key TEXT,                       -- agent yaml 中的稳定 key，或迁移来源 id
  type TEXT NOT NULL,                    -- "cron" | "watcher"
  name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  project TEXT,
  channel_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 2,
  enabled INTEGER NOT NULL DEFAULT 1,

  cron_expr TEXT,
  check_command TEXT,
  condition TEXT,
  interval_ms INTEGER,
  cooldown_ms INTEGER,

  last_run_at TEXT,
  next_run_at TEXT,
  last_check_at TEXT,
  last_triggered_at TEXT,
  last_task_id TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

约束：

- `type="cron"` 时必须有 `cron_expr`。
- `type="watcher"` 时必须有 `check_command`、`interval_ms`、`cooldown_ms`。
- `agent_name` 必须能在 `AgentRegistry` 中解析到 active/paused/disabled Agent。
- disabled Agent 的 schedule 可以存在，但触发时不创建执行任务，记录 skipped。

### 4.2 `team_schedule_runs`

建议增加运行历史表，避免只依赖 `task_logs` 查最近结果。

```sql
CREATE TABLE team_schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,            -- "cron" | "watcher" | "manual"
  task_id TEXT,
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL,                  -- "created" | "skipped" | "failed_to_create"
  trigger_payload TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
```

用途：

- Calendar 页面列出最近运行历史。
- 从 schedule run 跳转到 task。
- 记录 paused/disabled/missing agent 导致的 skip。

---

## 5. Agent YAML 配置

现有 `cron_jobs` 只有：

```yaml
cron_jobs:
  - cron: "0 8 * * *"
    prompt: "Run daily task"
```

建议扩展为兼容旧格式的新格式：

```yaml
cron_jobs:
  - key: daily-podcast-check
    name: Daily podcast check
    cron: "0 8 * * *"
    prompt: "Check for new podcast episodes from subscribed feeds."
    project: podcast-translation
    tags:
      - podcast
      - scheduled
    priority: 1
    enabled: true
```

新增 watcher 配置：

```yaml
watchers:
  - key: feed-updated
    name: Feed updated
    check_command: "test -f ~/.little_claw/inbox/new-feed.txt"
    condition: "new feed marker exists"
    prompt: "Process the new feed marker and create translation tasks."
    interval_minutes: 5
    cooldown_minutes: 30
    project: podcast-translation
    tags:
      - podcast
      - watcher
    enabled: true
```

兼容规则：

- 旧 `cron_jobs[].cron + prompt` 继续有效。
- 没有 `key` 时，使用 `agentName + index + cron + prompt hash` 生成稳定 source key。
- 没有 `name` 时，默认 `Scheduled task {index + 1}`。
- 没有 `project` 时，默认使用 `agent.default_project`。
- 没有 `enabled` 时默认 true。

---

## 6. 后端模块计划

### 6.1 新增 `TeamScheduleStore`

职责：

- 初始化 `team_schedules` 和 `team_schedule_runs`。
- CRUD schedule。
- 同步 agent.yaml 声明到 DB。
- list/filter schedules。
- 记录 run。
- 更新 lastRun/nextRun/lastTaskId/lastStatus/lastError。

接口草案：

```ts
export interface TeamSchedule {
  id: string;
  source: "agent_yaml" | "ui" | "migration";
  sourceKey?: string;
  type: "cron" | "watcher";
  name: string;
  agentName: string;
  prompt: string;
  project?: string;
  channelId?: string;
  tags: string[];
  priority: number;
  maxRetries: number;
  enabled: boolean;
  cronExpr?: string;
  checkCommand?: string;
  condition?: string;
  intervalMs?: number;
  cooldownMs?: number;
  lastRunAt?: string;
  nextRunAt?: string;
  lastCheckAt?: string;
  lastTriggeredAt?: string;
  lastTaskId?: string;
  lastStatus?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export class TeamScheduleStore {
  syncFromAgents(agents: RegisteredAgent[]): SyncResult;
  listSchedules(filter?: TeamScheduleFilter): TeamSchedule[];
  getSchedule(id: string): TeamSchedule | null;
  createSchedule(params: CreateTeamScheduleParams): TeamSchedule;
  updateSchedule(id: string, updates: UpdateTeamScheduleParams): TeamSchedule | null;
  deleteSchedule(id: string): void;
  recordRun(params: RecordScheduleRunParams): TeamScheduleRun;
}
```

### 6.2 新增 `TeamCronScheduler`

可以选择两种实现：

1. 复用现有 `CronScheduler`，但需要把 `sessionId` 泛化成 owner。
2. 新增 team 专用 scheduler，直接读 `team_schedules`。

建议先做第 2 种。原因是旧 `cron_jobs` 表以 chat session 为中心，强行兼容会产生命名和迁移复杂度。

职责：

- 每分钟查询 enabled `type="cron"` schedules。
- 匹配 cron 表达式。
- 更新 `lastRunAt` / `nextRunAt`。
- emit `{ type: "team_cron_trigger", schedule }`。

### 6.3 新增 `TeamWatcherScheduler`

职责：

- 为 enabled `type="watcher"` schedules 启动独立 interval。
- 执行 `check_command`。
- exit code 0 且过 cooldown 后触发。
- 更新 `lastCheckAt` / `lastTriggeredAt`。
- emit `{ type: "team_watcher_trigger", schedule, checkOutput }`。

安全注意：

- watcher shell command 本质是后台命令执行，应明确只允许本地配置或受信 UI 创建。
- 如果未来提供远程创建 watcher，需要加审批或权限限制。

### 6.4 新增 `TeamScheduleAdapter`

职责：

- 订阅 team cron/watcher trigger。
- 校验 Agent 是否存在、是否 active。
- 创建 `TaskQueue` 任务。
- 写入 `team_schedule_runs`。
- 可选创建系统 team message，提示 schedule 已触发。

伪代码：

```ts
function handleTrigger(event: TeamScheduleTrigger) {
  const schedule = event.schedule;
  const agent = agentRegistry.get(schedule.agentName);

  if (!agent || agent.config.status !== "active") {
    store.recordRun({
      scheduleId: schedule.id,
      status: "skipped",
      agentName: schedule.agentName,
      error: !agent ? "Agent not found" : `Agent is ${agent.config.status}`,
    });
    return;
  }

  const task = taskQueue.createTask({
    title: `[scheduled] ${schedule.name}`,
    description: buildScheduledTaskDescription(schedule, event),
    createdBy: `scheduler:${schedule.id}`,
    assignedTo: schedule.agentName,
    project: schedule.project,
    channelId: schedule.channelId,
    tags: unique(["scheduled", schedule.type, ...schedule.tags]),
    priority: schedule.priority,
    maxRetries: schedule.maxRetries,
  });

  store.recordRun({
    scheduleId: schedule.id,
    triggerType: schedule.type,
    status: "created",
    taskId: task.id,
    agentName: schedule.agentName,
    triggerPayload: event,
  });
}
```

### 6.5 接入 `createLovelyOctopusRuntime`

`createLovelyOctopusRuntime` 应该持有：

- `teamScheduleStore`
- `teamCronScheduler`
- `teamWatcherScheduler`
- `teamScheduleAdapter`

启动顺序：

1. `agentRegistry.loadAll()`。
2. `teamScheduleStore.syncFromAgents(registeredAgents)`。
3. 创建 task/messages/channels/workers/coordinator。
4. 创建 schedule adapter。
5. runtime.start() 时启动 workers、coordinator、team schedulers。
6. runtime.stop() 时停止 team schedulers、workers、coordinator。

注意：

- 旧 chat `CronScheduler` 和 `EventWatcher` 可以继续存在，服务端同时跑两套 scheduler。
- team schedule 不应该写入旧 `cron_jobs` / `event_watchers` 表。

---

## 7. Gateway Protocol

新增 client messages：

```ts
export interface ListTeamSchedulesMessage {
  type: "list_team_schedules";
  agentName?: string;
  project?: string;
  enabled?: boolean;
  limit?: number;
}

export interface UpdateTeamScheduleMessage {
  type: "update_team_schedule";
  scheduleId: string;
  updates: {
    enabled?: boolean;
    name?: string;
    prompt?: string;
    cronExpr?: string;
    project?: string;
    tags?: string[];
    priority?: number;
  };
}

export interface RunTeamScheduleNowMessage {
  type: "run_team_schedule_now";
  scheduleId: string;
}

export interface GetTeamScheduleRunsMessage {
  type: "get_team_schedule_runs";
  scheduleId?: string;
  limit?: number;
}
```

新增 server messages：

```ts
export interface TeamSchedulesListMessage {
  type: "team_schedules_list";
  schedules: TeamScheduleInfo[];
}

export interface TeamScheduleUpdatedMessage {
  type: "team_schedule_updated";
  schedule: TeamScheduleInfo;
}

export interface TeamScheduleTriggeredMessage {
  type: "team_schedule_triggered";
  schedule: TeamScheduleInfo;
  run: TeamScheduleRunInfo;
  task?: TaskInfo;
}

export interface TeamScheduleRunsMessage {
  type: "team_schedule_runs";
  runs: TeamScheduleRunInfo[];
}
```

Broadcast 规则：

- schedule 被创建、更新、启停时广播 `team_schedule_updated`。
- schedule 触发并创建 task 时广播 `team_schedule_triggered`，随后 `TaskQueue` 会自然广播 `task_updated`。
- schedule run 失败或 skipped 时也广播 `team_schedule_triggered`，让 Calendar 可见。

---

## 8. 前端展示计划

### 8.1 Calendar 页面

当前 Calendar 是 placeholder，应改成 team schedule 管理页。

主内容：

- 左侧：schedule 列表。
- 右侧：选中 schedule 的详情和最近 runs。

列表字段：

- enabled 状态。
- type：cron / watcher。
- name。
- Agent。
- project。
- next run。
- last run。
- last status。

详情字段：

- prompt。
- cron expression 或 watcher command。
- tags。
- last task link。
- last error。
- run history。

操作：

- Enable / Disable。
- Run now。
- Refresh。
- 跳转到 latest task。
- 跳转到 project channel 或 agent DM。

### 8.2 Tasks 页面

定时触发创建出来的任务应该作为普通 task 显示。

增强点：

- 对包含 `scheduled` tag 的任务显示 Scheduled badge。
- 显示来源：`scheduler:{scheduleId}`。
- task card 上增加 next/last schedule 信息不是必须，避免卡片过重。

### 8.3 Channels 页面

结果展示复用现有 TimelineMessage。

规则：

- 有 project：完整结果发到 project channel。
- 没有 project：结果发到 Agent DM。
- 同时可以发一条短通知到 Agent DM，便于按 Agent 查看活动。

### 8.4 Team 页面

在 Agent 详情页增加 Scheduled Tasks 小节：

- 展示该 Agent 绑定的 schedule 数量。
- 展示 enabled count。
- 展示下次运行时间。
- 提供跳转到 Calendar 的过滤视图。

---

## 9. 迁移和兼容

### 9.1 旧 chat cron/watchers

旧 `manage_cron` / `manage_watcher` 不要立刻删除。它们仍属于 chat session 自动化。

短期策略：

- 保留旧工具和旧表。
- Team 模式新增独立 API 和 UI。
- 在 CLI `/cron` 和 `/watchers` 中可继续只显示 chat scheduler。
- Mission Control Calendar 只显示 team schedules，避免混淆。

中期策略：

- 新增 migration 工具，把某个 chat cron 迁移成 team schedule。
- 迁移时必须选择 agentName。

### 9.2 agent.yaml `cron_jobs`

启动同步策略：

- 如果 DB 中不存在同 sourceKey 的 schedule，则创建。
- 如果 YAML 中同 sourceKey 内容变更，则更新 DB 中声明式字段，但保留运行字段。
- 如果 YAML 中删除某个 sourceKey，不建议直接删除 DB schedule；标记为 `source_missing` 或 disabled，避免误删历史。

### 9.3 重复触发防护

需要避免同一分钟重复创建多个 task：

- `team_schedule_runs` 可以记录 trigger minute。
- 或在 `team_schedules` 上记录 `lastRunAt`，同一分钟内 skip。
- 对 watcher 保留 cooldown。

---

## 10. 测试计划

### 10.1 Store 单元测试

覆盖：

- 创建 cron schedule。
- 创建 watcher schedule。
- list/filter。
- update enable/disable。
- recordRun。
- syncFromAgents 兼容旧 `cron_jobs` 格式。
- agent yaml 改名/删除时不误删运行历史。

### 10.2 Scheduler 单元测试

覆盖：

- cron 到点触发。
- disabled schedule 不触发。
- nextRunAt 更新。
- watcher exit code 0 触发。
- watcher exit code 非 0 不触发。
- cooldown 生效。

### 10.3 Adapter 单元测试

覆盖：

- trigger 后创建 assigned task。
- task assignedTo 等于 schedule.agentName。
- project/channel/tags/priority/maxRetries 正确传递。
- missing agent 记录 skipped run。
- paused/disabled agent 记录 skipped run。
- watcher check output 被写入 task description。

### 10.4 Runtime 集成测试

覆盖：

- `createLovelyOctopusRuntime` 启动时同步 agent.yaml schedules。
- runtime.start 启动 team schedulers。
- runtime.stop 停止 team schedulers。
- schedule trigger 后 AgentWorker 能执行 task。

### 10.5 Gateway/Web 测试

覆盖：

- `list_team_schedules` 返回数据。
- enable/disable 后广播 update。
- run now 创建 task。
- Calendar 页面能显示 schedules 和 runs。

---

## 11. 分阶段实施

### Phase 1: 数据和同步

目标：

- 实现 `TeamScheduleStore`。
- 扩展 `AgentRegistry` 类型，支持 cron_jobs 新字段和 watchers。
- 从 agent.yaml 同步 schedules 到 DB。

验收：

- 单元测试通过。
- 启动 runtime 后 DB 中能看到 agent.yaml 中声明的 schedules。

### Phase 2: Team scheduler 和 adapter

目标：

- 实现 `TeamCronScheduler`。
- 实现 `TeamWatcherScheduler`。
- 实现 `TeamScheduleAdapter`。
- 接入 `createLovelyOctopusRuntime` 生命周期。

验收：

- cron/watch 触发后创建 `TaskQueue` 任务。
- 任务由正确 Agent 执行。
- skipped/failed_to_create 有 run 记录。

### Phase 3: Gateway API

目标：

- 增加 protocol 类型。
- 增加 Gateway handlers。
- 广播 schedule update/trigger。

验收：

- WebSocket 能 list schedules。
- UI 或测试可 enable/disable。
- run now 能创建任务。

### Phase 4: Mission Control Calendar

目标：

- 替换 Calendar placeholder。
- 展示 schedules、详情、runs。
- 支持 enable/disable/run now。

验收：

- Calendar 可查看所有 team schedules。
- 点击 latest task 能定位到 Tasks 或 Channels。
- schedule 触发后 UI 能实时更新。

### Phase 5: 迁移工具和清理

目标：

- 可选提供 chat cron -> team schedule 迁移命令。
- 文档更新。
- 重新审视旧 `manage_cron` / `manage_watcher` 的提示，避免用户误以为它们是 team schedule。

验收：

- 用户能明确区分 chat scheduled jobs 和 team scheduled tasks。
- 旧功能不回归。

---

## 12. 风险和决策点

### 12.1 是否复用旧 `cron_jobs` 表

不建议。旧表核心字段是 `session_id`，team 模式核心字段是 `agent_name`。强行复用会让模型语义混乱。

### 12.2 schedule 触发时 Agent paused 怎么办

建议默认 skipped，不自动恢复 Agent。

理由：

- paused 是人类明确的运行准入开关。
- 自动恢复可能违反预期。
- skipped run 在 Calendar 中可见，用户能手动处理。

### 12.3 是否允许 unassigned scheduled task

不建议。Team scheduled task 的核心价值就是有 Agent owner。

如果确实需要动态分配，绑定到 `coordinator`。

### 12.4 watcher shell command 的安全边界

本地 YAML 配置创建 watcher 可以接受。远程 UI 创建 watcher 风险更高，后续应加：

- 仅本机管理员可创建。
- 或需要审批。
- 或限制命令模板。

### 12.5 结果是否需要单独结果表

短期不需要。结果已经存在于：

- `tasks.result`
- `task_logs`
- `team_messages`
- `team_schedule_runs.last_task_id`

如果后续要做报表，再加 materialized view 或专门查询接口。

---

## 13. 推荐最终用户体验

一个 Agent 可以这样声明：

```yaml
name: podcast-translator
display_name: Podcast Translator
role: Translate English podcasts to Chinese
status: active
default_project: podcast-translation

task_tags:
  - podcast
  - translation

cron_jobs:
  - key: daily-feed-check
    name: Daily feed check
    cron: "0 8 * * *"
    prompt: "Check subscribed podcast feeds. If new episodes exist, create translation tasks."
    project: podcast-translation
    tags:
      - podcast
      - scheduled
    enabled: true
```

每天 8 点：

1. Calendar 显示 `Daily feed check` triggered。
2. Tasks 页面出现 `[scheduled] Daily feed check`，assigned to `podcast-translator`。
3. AgentWorker 执行任务。
4. 完成后结果写到 `#podcast-translation`，Agent DM 收到简短通知。
5. Calendar 的 last task 指向该 task。

这就是 team-native 定时任务的理想形态。
