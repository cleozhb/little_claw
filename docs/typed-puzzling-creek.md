# Plan: Team 模式 HITL 状态持久化到 SQLite

## Context

Team 模式的审批流程（HITL）当前依赖内存中的 `taskLoops` 和 `taskConversations` Map 来跨审批周期保持 AgentLoop 和对话状态。进程重启后这些状态丢失，导致恢复不完整。Chat 模式已有完善的持久化方案（`Conversation` 类每次操作都写 DB，`session_approvals` 表记录审批），Team 模式应复用同一套机制，让 SQLite 成为唯一状态源。

## 改动后的时序图

### 数据层关系

```
┌─────────────────────────── SQLite: data/little_claw.db ───────────────────────────┐
│                                                                                    │
│  ┌─────────────────────┐   ┌──────────────────┐   ┌────────────────────────────┐  │
│  │ sessions            │   │ messages         │   │ tool_results               │  │
│  │ ─────────────────── │   │ ──────────────── │   │ ────────────────────────── │  │
│  │ id (PK)             │◄──│ session_id (FK)  │   │ message_id (FK)            │  │
│  │ title               │   │ role             │   │ tool_use_id                │  │
│  │ system_prompt       │   │ content (JSON)   │   │ tool_name                  │  │
│  │ created_at          │   │ created_at       │   │ tool_input (JSON)          │  │
│  └─────────────────────┘   └──────────────────┘   │ tool_output                │  │
│                                                    │ is_error                   │  │
│  ┌─────────────────────┐   ┌──────────────────────┘────────────────────────────┘  │
│  │ session_approvals   │   │                                                      │
│  │ ─────────────────── │   │  ┌──────────────────┐   ┌────────────────────────┐   │
│  │ session_id (FK)     │   │  │ tasks            │   │ task_logs              │   │
│  │ tool_name           │   │  │ ──────────────── │   │ ──────────────────────  │   │
│  │ params (JSON)       │   │  │ id (PK)          │   │ task_id (FK)           │   │
│  │ status              │   │  │ status           │   │ event_type             │   │
│  └─────────────────────┘   │  │ session_id (FK)──┼──>│ content                │   │
│                             │  │ approval_data    │   └────────────────────────┘   │
│  封装层:                    │  │ ...              │                                │
│  ┌───────────────────┐     │  └──────────────────┘                                │
│  │ Conversation 类   │─────┘                                                      │
│  │ (操作 sessions +  │     封装层:                                                 │
│  │  messages +        │     ┌───────────────────┐                                  │
│  │  tool_results)     │     │ TaskQueue 类      │                                  │
│  └───────────────────┘     │ (操作 tasks +     │                                  │
│                             │  task_logs)        │                                  │
│                             └───────────────────┘                                  │
└────────────────────────────────────────────────────────────────────────────────────┘

新增关联: tasks.session_id → sessions.id（一个任务对应一段持久化对话）
```

### 主流程时序（任务执行 + 审批）

```
┌──────────┐     ┌──────────┐     ┌───────────────┐     ┌────────────────┐
│  Worker  │     │AgentLoop │     │ Conversation  │     │   TaskQueue    │
│  (tick)  │     │(每次新建) │     │(SQLite 封装)  │     │ (SQLite 封装)  │
└────┬─────┘     └────┬─────┘     └──────┬────────┘     └───────┬────────┘
     │                 │                  │                      │
     │ ① 领取任务 (status=assigned/approved)                     │
     │───────────────────────────────────────────────────────────>│
     │                 │                  │                      │
     │ ② getOrCreateTaskSession(taskId)   │                      │
     │  task.sessionId 为空?              │                      │
     │  → Conversation.createNew() ──────>│ INSERT sessions      │
     │  → tasks.setSessionId() ──────────────────────────────────>│ UPDATE tasks
     │  task.sessionId 非空?              │                      │
     │  → Conversation.loadExisting() ───>│ SELECT messages      │
     │<───────────────────────────────────│                      │
     │                 │                  │                      │
     │ ③ new AgentLoop(conversation)      │                      │
     │────────────────>│                  │                      │
     │                 │                  │                      │
     │ ④ db.getApprovedCallKeys(sessionId)│                      │
     │  → loop.approveCallKey(key)        │                      │
     │────────────────>│                  │                      │
     │                 │                  │                      │
     │ ⑤ loop.run(prompt)                 │                      │
     │────────────────>│                  │                      │
     │                 │ addToolUse()     │                      │
     │                 │────────────────>│ INSERT messages       │
     │                 │ addToolResults() │                      │
     │                 │────────────────>│ INSERT tool_results   │
     │                 │                  │                      │
     ╔════════════════════════════════════════════════════════════╗
     ║  APPROVAL GATE 触发 (shell 命令命中规则)                   ║
     ╚════════════════════════════════════════════════════════════╝
     │                 │                  │                      │
     │ ⑥ yield approval_gate_triggered    │                      │
     │<────────────────│                  │                      │
     │                 │                  │                      │
     │ ⑦ db.createSessionApproval(sid, tool, params)             │
     │────────────────────────────────────────> INSERT session_approvals
     │                 │                  │                      │
     │ ⑧ tasks.requestApproval(taskId, data)                     │
     │───────────────────────────────────────────────────────────>│
     │                 │                  │     UPDATE tasks (status=awaiting_approval)
     │                 │                  │                      │
     │ ⑨ loop.abort()  │                  │                      │
     │────────────────>│ (generator 结束)  │                      │
     │                 │                  │                      │
     │ runTask() 返回，Worker idle        │                      │
     │                 │                  │                      │
     ═══════════════════ 人类审批等待 ════════════════════════════
     │                 │                  │                      │
     │                 │                  │     人类点击"批准"    │
     │                 │                  │     UPDATE tasks (status=approved)
     │                 │                  │                      │
     │ ⑩ 下一轮 tick: 发现 status=approved                      │
     │───────────────────────────────────────────────────────────>│
     │                 │                  │                      │
     │ ⑪ getOrCreateTaskSession — loadExisting (从 DB 完整恢复)  │
     │────────────────────────────────────>│ SELECT messages     │
     │<───────────────────────────────────│ (含 [APPROVAL REQUIRED] 占位)
     │                 │                  │                      │
     │ ⑫ new AgentLoop + 恢复 approvedCalls                     │
     │────────────────>│                  │                      │
     │                 │                  │                      │
     │ ⑬ directExecuteApprovedTool()      │                      │
     │  → tool.execute(params)            │                      │
     │  → conversation.replaceLastToolResult()                   │
     │────────────────────────────────────>│ UPDATE tool_results │
     │                 │                  │                      │
     │ ⑭ loop.run("Continue the task.")   │                      │
     │────────────────>│                  │                      │
     │                 │ (gate 放行，approvedCalls 已恢复)        │
     │                 │                  │                      │
     │ ⑮ 任务完成      │                  │                      │
     │───────────────────────────────────────────────────────────>│
     │                 │                  │     UPDATE tasks (status=completed)
```

### DM 处理流程（不持久化）

```
┌──────────┐     ┌──────────┐     ┌─────────────────────┐
│  Worker  │     │AgentLoop │     │EphemeralConversation │
│  (tick)  │     │          │     │   (纯内存，无 DB)    │
└────┬─────┘     └────┬─────┘     └──────────┬──────────┘
     │                 │                      │
     │ 发现 DM 消息    │                      │
     │                 │                      │
     │ new EphemeralConversation()            │
     │───────────────────────────────────────>│
     │                 │                      │
     │ new AgentLoop(ephemeral, {无 approvalRules})
     │────────────────>│                      │
     │                 │                      │
     │ loop.run(dmPrompt)                     │
     │────────────────>│ (无审批 gate)        │
     │                 │                      │
     │ 回复写入 TeamMessageStore              │
     │                 │                      │
     │ 对话丢弃（DM 无状态，不需要恢复）      │
```

DM 场景保持使用 `EphemeralConversation`，原因：
- DM 是一次性问答，没有审批 gate（不注入 `approvalRules`）
- 不需要跨重启恢复
- 避免为短暂对话创建无用的 DB 记录

### 异常/重试流程

```
┌──────────────────────────────────────────────────────────────────────────┐
│  场景 A: 进程重启（任务在 awaiting_approval 期间崩溃）                    │
│                                                                          │
│  重启后:                                                                 │
│  1. TaskQueue 从 DB 加载 → task.status = "awaiting_approval"             │
│  2. 人类审批 → status 变为 "approved"                                    │
│  3. Worker tick 领取任务                                                 │
│  4. task.sessionId 非空 → Conversation.loadExisting() 恢复完整对话       │
│  5. db.getApprovedCallKeys() 恢复 approvedCalls                          │
│  6. directExecuteApprovedTool() 执行被拦截的工具                         │
│  7. loop.run() 继续 → 无数据丢失                                        │
│                                                                          │
│  ✓ 与正常流程完全一致，无特殊处理                                        │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  场景 B: 进程重启（任务在 running 期间崩溃，LLM 调用中途断开）           │
│                                                                          │
│  重启后:                                                                 │
│  1. TaskQueue 从 DB 加载 → task.status = "running"                       │
│  2. Conversation.loadExisting() 恢复对话                                 │
│     - 如果 assistant 消息有 tool_use 但无对应 tool_result:               │
│       rebuildFromDB() 自动插入占位: "(execution interrupted, no result)" │
│  3. Worker 重新 run() → LLM 看到中断的上下文，自行决定重试或跳过        │
│                                                                          │
│  ✓ 已有机制处理，无需额外代码                                            │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  场景 C: 任务执行失败 → 自动重试                                         │
│                                                                          │
│  1. AgentLoop 返回 error → Worker 调 tasks.failTask()                    │
│  2. retryCount < maxRetries → status 重置为 "pending"                    │
│  3. 下一轮 tick 重新领取 → getOrCreateTaskSession()                      │
│     - task.sessionId 非空 → loadExisting() 恢复之前的对话                │
│     - LLM 看到之前的尝试和错误，可以调整策略                             │
│  4. 如果 retryCount >= maxRetries → status = "failed"，任务终止          │
│                                                                          │
│  ✓ 重试时保留完整历史，LLM 能从错误中学习                                │
└──────────────────────────────────────────────────────────────────────────┘
```

## 方案概述

将 Team 任务的对话从 `EphemeralConversation`（纯内存）切换为 `Conversation`（持久化），复用现有的 `sessions` + `messages` + `tool_results` + `session_approvals` 表。每个任务关联一个 session，审批恢复时从 DB 完整重建。

## 实现步骤

### 1. TaskQueue 增加 `session_id` 字段

**文件**: `src/team/TaskQueue.ts`

- `Task` 接口增加 `sessionId?: string`
- `TaskRow` 增加 `session_id: string | null`
- `tasks` 表增加列: `ALTER TABLE tasks ADD COLUMN session_id TEXT`（在 `initTables` 中用 try/catch 做迁移）
- `stmtInsertTask` / `stmtUpdateTask` 增加 `session_id` 参数位
- `rowToTask` / `taskParams` 处理新字段
- 新增 `setSessionId(taskId: string, sessionId: string)` 方法（单独 UPDATE 语句，避免每次都全量写）

### 2. Conversation 增加 `replaceLastToolResult` 方法

**文件**: `src/core/Conversation.ts`

- 添加 `replaceLastToolResult(toolUseId: string, output: string, isError: boolean): boolean`
- 内存侧：同 `EphemeralConversation` 的逻辑，遍历 messages 找到对应 block 并替换
- DB 侧：调用 `db.updateToolResult(toolUseId, output, isError)` 更新 `tool_results` 表

### 3. Database 增加 `updateToolResult` 方法

**文件**: `src/db/Database.ts`

- 新增预编译语句: `UPDATE tool_results SET tool_output = ?2, is_error = ?3 WHERE tool_use_id = ?1`
- 新增方法: `updateToolResult(toolUseId: string, output: string, isError: boolean): void`

### 4. AgentWorker 重构（核心改动）

**文件**: `src/team/AgentWorker.ts`

**新增依赖**:
- `AgentWorkerOptions` 增加 `db: Database`
- 构造函数保存 `this.db`

**删除**:
- `private taskConversations = new Map<string, EphemeralConversation>()`
- `private taskLoops = new Map<string, AgentLoop>()`
- `getTaskConversation()` 方法
- `getTaskLoop()` 方法
- 所有 `.taskConversations.delete()` 和 `.taskLoops.delete()` 调用

**新增**:
- `getOrCreateTaskSession(taskId: string): Conversation` 方法:
  ```
  1. 从 TaskQueue 获取 task
  2. 如果 task.sessionId 存在 → Conversation.loadExisting(db, sessionId)
  3. 如果不存在 → Conversation.createNew(db, systemPrompt)，然后 tasks.setSessionId(taskId, sessionId)
  ```
- `createTaskLoop(conversation: Conversation, project?: string, channelId?: string): AgentLoop` — 纯工厂方法，不缓存

**修改 `runTask()`**:
1. 调用 `getOrCreateTaskSession(taskId)` 获取持久化 Conversation
2. 调用 `createTaskLoop(conversation, ...)` 创建 AgentLoop（每次新建，不缓存）
3. 从 DB 恢复 approvedCalls: `db.getApprovedCallKeys(conversation.getSessionId())` → `loop.approveCallKey(key)`
4. `directExecuteApprovedTool` 接收 `Conversation` 类型（已有 `replaceLastToolResult`）
5. 任务完成/取消时不需要清理 Map（没有 Map 了）

**修改 `handleAgentEvent()`**:
- 当 `approval_gate_triggered` 时，除了调 `tasks.requestApproval()`，还要调 `db.createSessionApproval(sessionId, ...)` 持久化审批记录

### 5. server.ts 传入 db

**文件**: `src/server.ts`

- `createAgentWorkers` 调用处增加 `db` 参数

### 6. 清理 EphemeralConversation 的 import

**文件**: `src/team/AgentWorker.ts`

- 移除 `EphemeralConversation` import（任务执行不再使用）
- DM 处理 (`runDirectMessages`) 保留使用 `EphemeralConversation`（DM 是无状态的，不需要持久化）

## 文件变更清单

| 文件 | 变更类型 |
|------|---------|
| `src/team/TaskQueue.ts` | 增加 `session_id` 字段 + 迁移 + setter |
| `src/db/Database.ts` | 增加 `updateToolResult` 方法 |
| `src/core/Conversation.ts` | 增加 `replaceLastToolResult` 方法 |
| `src/team/AgentWorker.ts` | 重构：删除内存 Map，改用 DB 持久化 |
| `src/server.ts` | 传 `db` 给 AgentWorker |
| `tests/team/AgentWorker.test.ts` | 适配新接口（传入 db mock 或真实 DB） |

## 验证方案

1. `bun test tests/team/` — 所有现有测试通过
2. 新增测试用例：
   - 任务执行中触发审批 → 验证 session_approvals 表有记录
   - 模拟进程重启（丢弃内存状态，重新从 DB 加载）→ 验证对话历史和 approvedCalls 完整恢复
   - `directExecuteApprovedTool` 后验证 `tool_results` 表中的占位结果被替换
3. 手动测试：在 mission-control 页面给 tinker 分配需要 shell 的任务，审批后确认不再重复弹窗
