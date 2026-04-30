# Lovely Octopus 实现方案

这份文档是给 Codex 后续分阶段实现用的。每个模块都包含：

1. 目标
2. 给 Codex 做任务的 prompt
3. 验收标准
4. 我需要理解的重点技术和设计

核心原则：
- 人类是 CEO，可以直接和任意 Agent 或项目频道沟通
- Coordinator 只是协调者，不是所有消息的唯一入口
- 简单路由和控制命令由确定性代码处理，复杂拆解和跨 Agent 协调用 Coordinator
- 所有长期任务、审批、项目讨论都要落库，不能只存在某个 Agent 的上下文里

---

## 1. Agent 注册系统和三文件指令模型

### 目标

实现常驻 Agent 注册系统。每个 Agent 都是 `~/.little_claw/agents/{name}/` 下的一个目录，包含：

```text
agent.yaml   # 机器可读配置：权限、路由、skills、cron、审批、并发限制
SOUL.md      # 人格、语气、表达风格、禁用词、输出审美
AGENTS.md    # 做事流程：步骤、失败处理、PR 规则、汇报规则、交接规则
```

目录示例：

```text
~/.little_claw/agents/
├── coordinator/
│   ├── agent.yaml
│   ├── SOUL.md
│   └── AGENTS.md
├── coder/
│   ├── agent.yaml
│   ├── SOUL.md
│   └── AGENTS.md
└── podcast-translator/
    ├── agent.yaml
    ├── SOUL.md
    └── AGENTS.md
```

`agent.yaml` 示例：

```yaml
name: podcast-translator
display_name: Podcast Translator
emoji: "🎙️"
color: "#E86C8D"
role: "Translate English podcasts to Chinese"
status: active

aliases:
  - podcast
  - translator
direct_message: true
default_project: podcast-translation

tools:
  - read_file
  - write_file
  - shell

skills:
  - podcast-translation-skill

task_tags:
  - podcast
  - translation
  - english
  - chinese
  - audio

cron_jobs:
  - cron: "0 8 * * *"
    prompt: "Check for new podcast episodes from subscribed feeds"

requires_approval:
  - "publish translated content"
  - "select new podcasts to translate"

max_concurrent_tasks: 2
max_tokens_per_task: 50000
timeout_minutes: 30
```

加载后得到 `RegisteredAgent`：

```ts
type RegisteredAgent = {
  config: AgentConfigFromYaml;
  soul: string;
  operatingInstructions: string;
  currentTasks: string[];
  status: "idle" | "working" | "waiting_approval" | "paused";
};
```

### 给 Codex 做任务的 prompt

```text
请实现 Lovely Octopus 的 AgentRegistry。

要求：
1. 新增 src/team/AgentRegistry.ts。
2. 从 ~/.little_claw/agents/ 扫描所有子目录。
3. 每个 Agent 目录必须读取 agent.yaml、SOUL.md、AGENTS.md。
4. agent.yaml 负责工具权限、aliases、task_tags、cron_jobs、requires_approval、并发和超时配置。
5. SOUL.md 只进入人格和表达风格上下文。
6. AGENTS.md 只进入做事流程上下文。
7. 提供 loadAll()、get(name)、listActive()、create()、update()、delete()。
8. create() 只创建缺失文件，不覆盖已有文件。
9. update() 必须分别支持更新 config、soul、operatingInstructions。
10. 路径必须限制在 ~/.little_claw/agents/ 内，避免路径穿越。
11. 补充必要类型定义和测试。

实现时遵循现有代码风格，不要改动无关模块。
```

### 验收标准

- 启动时能扫描多个 Agent，并正确读取 `agent.yaml + SOUL.md + AGENTS.md`
- `status=disabled` 的 Agent 不会出现在 `listActive()`
- `aliases` 可以被后续 TeamRouter 查询到
- 缺少 `SOUL.md` 或 `AGENTS.md` 时给出明确错误或创建默认模板，行为要一致
- `create()` 不覆盖用户已有文件
- 非法 Agent 名称不能逃逸到 `~/.little_claw/agents/` 之外
- 单元测试覆盖：正常加载、缺文件、非法路径、active 过滤、update 局部更新

### 我需要理解的重点技术和设计

- `SOUL.md`、`AGENTS.md`、`agent.yaml` 是三个不同层次，不要互相替代
- 权限和审批永远以 `agent.yaml` 为准，不能被 prompt 覆盖
- `SOUL.md` 是"像谁"，`AGENTS.md` 是"怎么做事"
- AgentRegistry 只负责文件化配置，不负责运行 Agent
- 后续 AgentLoop 组装 prompt 时，应该明确分块：

```text
<agent_soul>
SOUL.md
</agent_soul>

<agent_operating_instructions>
AGENTS.md
</agent_operating_instructions>

<team_context>
团队、项目、任务摘要
</team_context>
```

---

## 2. TaskQueue 任务队列和状态机

### 目标

实现持久化任务队列，负责任务创建、分配、运行、审批、失败重试、完成、取消。

核心表：

```sql
CREATE TABLE tasks (
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
);

CREATE TABLE task_logs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_name TEXT,
  event_type TEXT NOT NULL,
  content TEXT,
  created_at TEXT NOT NULL
);
```

状态：

```text
pending -> assigned -> running -> completed
running -> awaiting_approval -> approved -> running
running -> awaiting_approval -> rejected -> running 或 cancelled
running -> failed -> pending 或 failed
pending / assigned / running / awaiting_approval -> cancelled
```

### 给 Codex 做任务的 prompt

```text
请实现 Lovely Octopus 的 TaskQueue。

要求：
1. 新增 src/team/TaskQueue.ts。
2. 在 SQLite 中初始化 tasks 和 task_logs 表。
3. 实现 createTask、getTask、listTasks、assignTask、startTask、requestApproval、approveTask、rejectTask、completeTask、failTask、cancelTask、delegateTask、addProgress。
4. createTask 支持 title、description、priority、tags、project、channelId、sourceMessageId、createdBy、assignedTo、dependsOn、dueAt。
5. 所有状态变化必须写 task_logs。
6. assignTask 必须检查依赖是否全部 completed。
7. failTask 在 retry_count < max_retries 时回到 pending，否则进入 failed。
8. rejectTask 状态进入 rejected，并保留人类回复，Worker 后续决定改方案还是取消。
9. listTasks 支持 status、assignedTo、project、tags、limit 过滤。
10. getPendingForAgent 根据 Agent task_tags、并发限制和依赖状态返回候选任务。
11. 补充状态机测试。

不要在 TaskQueue 里调用 LLM，也不要处理飞书或 WebSocket。
```

### 验收标准

- 能创建任务并写入 `created` 日志
- `pending -> assigned -> running -> completed` 正常流转
- 未满足依赖的任务不能被 assign
- 审批流程能保存 prompt、data、response
- reject 不伪装成 approve，必须有独立 `rejected` 状态
- 失败重试次数正确递增
- 超过重试次数后进入 `failed`
- 每个状态变化都有 `task_logs`
- 查询接口能按 Agent、项目、状态筛选

### 我需要理解的重点技术和设计

- TaskQueue 是状态机，不是聊天系统
- `task_logs` 记录执行事件，`team_messages` 记录团队沟通
- 任务状态必须可恢复，服务重启后不能丢
- 审批不是一个普通聊天消息，而是任务状态的一部分
- `rejected` 不代表任务失败，它代表人类拒绝了某一步，Agent 需要改方案或取消

---

## 3. TeamMessageStore 和项目频道

### 目标

实现团队消息持久化和虚拟项目频道。飞书不支持 Discord 式频道也没关系，系统内部自己维护频道。

核心表：

```sql
CREATE TABLE project_channels (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  context_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE external_channel_bindings (
  id TEXT PRIMARY KEY,
  external_channel TEXT NOT NULL,
  external_chat_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(external_channel, external_chat_id)
);

CREATE TABLE team_messages (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  project TEXT,
  task_id TEXT,
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'new',
  handled_by TEXT,
  external_channel TEXT,
  external_chat_id TEXT,
  external_message_id TEXT,
  created_at TEXT NOT NULL,
  handled_at TEXT
);
```

频道类型：

```text
project      # 项目频道，如 lovely-octopus
agent_dm     # 人类和单个 Agent 私聊，如 coder
coordinator  # 默认入口
system       # 系统通知
```

### 给 Codex 做任务的 prompt

```text
请实现 Lovely Octopus 的团队消息和项目频道存储。

要求：
1. 新增 src/team/TeamMessageStore.ts。
2. 新增 src/team/ProjectChannelStore.ts。
3. 初始化 project_channels、external_channel_bindings、team_messages 表。
4. TeamMessageStore 实现 createMessage、getMessage、listMessages、markRouted、markAcked、markInjected、markResolved、getPendingForAgent、getPendingForProject、getPendingForTask。
5. ProjectChannelStore 实现 createChannel、getChannel、listChannels、bindExternalChat、unbindExternalChat、resolveExternalChat、postMessage、listMessages。
6. external_channel + external_message_id 要去重，避免飞书重试导致重复消息。
7. channel slug 要校验，只允许安全字符。
8. 不要把任务状态事件写进 team_messages，任务状态仍然由 TaskQueue 和 task_logs 管。
9. 补充存储层测试。
```

### 验收标准

- 能创建项目频道并写入消息
- 能创建 Agent DM 消息
- 能把飞书 chat_id 绑定到某个项目频道
- 同一个飞书 event 重试不会重复创建消息
- `getPendingForAgent()` 能取出发给某 Agent 的未处理 DM
- `getPendingForProject()` 能取出某项目的新讨论
- `markInjected()` 后消息不会再次被注入

### 我需要理解的重点技术和设计

- 项目频道是 little_claw 内部抽象，不依赖飞书原生支持
- 飞书只是一个外部入口，Web UI 可以展示真正的频道
- 所有人类输入都先落库，再路由或注入
- `team_messages` 是团队沟通事实记录，后续可以用于项目摘要和记忆沉淀
- 任务和消息是关联关系，不是同一个东西

---

## 4. TeamRouter 人类消息路由

### 目标

实现所有人类入口的第一站：TeamRouter。它负责解析消息、快速 ack、落库、确定路由目标。

路由顺序：

1. 控制命令：`/task T123 approve`、`/task T123 cancel`、`/pause coder`
2. 审批回复：命中 `awaiting_approval` 任务
3. Agent DM：`@coder ...`、`@podcast ...`
4. 项目频道：`#lovely-octopus ...`
5. 当前外部会话绑定的项目或任务
6. 默认 Coordinator 入口

RouteResult：

```ts
type RouteResult = {
  messageId: string;
  ack: string;
  routedTo: {
    type: "agent" | "project" | "task" | "coordinator" | "system";
    id: string;
  };
  asyncWorkStarted: boolean;
};
```

### 给 Codex 做任务的 prompt

```text
请实现 Lovely Octopus 的 TeamRouter。

要求：
1. 新增 src/team/TeamRouter.ts。
2. routeHumanMessage(input) 接收 externalChannel、externalChatId、externalMessageId、userId、text。
3. 先写入 TeamMessageStore，再进行路由和状态更新。
4. 支持命令：
   - /task <id> approve [response]
   - /task <id> reject [response]
   - /task <id> cancel [reason]
   - /pause <agent>
   - /resume <agent>
   - /project <slug>
   - /status [#project | @agent]
5. 支持 @agent alias，根据 AgentRegistry 的 name 和 aliases 匹配。
6. 支持 #project，根据 ProjectChannelStore 匹配或创建频道。
7. 如果外部 chat 已绑定项目，未显式指定目标的消息默认进入该项目频道。
8. 无法确定目标时路由到 coordinator。
9. 控制命令用确定性代码处理，不调用 LLM。
10. routeHumanMessage 必须快速返回 ack，不等待长任务完成。
11. 补充路由解析测试。
```

### 验收标准

- `@coder 修复这个 bug` 路由到 `agent_dm:coder`
- `#lovely-octopus 加一个 AGENTS.md` 路由到 `project:lovely-octopus`
- `/project lovely-octopus` 能绑定当前飞书 chat
- 已绑定项目后，普通消息默认进入该项目频道
- `/task T123 approve` 直接调用 `approveTask`
- `/task T123 reject` 直接调用 `rejectTask`
- 未识别消息进入 `coordinator`
- 所有输入都返回可发给人类的 ack

### 我需要理解的重点技术和设计

- TeamRouter 不是 LLM，它是确定性路由器
- 人类消息优先，但不等于所有消息都要强行中断 Agent
- 控制命令优先级最高，普通补充通过消息表和 checkpoint 注入
- alias 路由要靠 `agent.yaml.aliases`
- TeamRouter 的目标是把入口变清晰，避免所有事情都进 Coordinator

---

## 5. AgentWorker 和运行中人类消息注入

### 目标

实现每个常驻 Agent 的运行时。AgentWorker 负责处理 Agent DM、领取任务、执行任务、暂停审批、恢复任务、接收人类补充消息。

核心边界：

- Team 模式只新增任务调度、团队消息持久化和上下文组装。
- 真正执行必须复用现有 `AgentLoop`，不能另写一套 LLM/tool calling 循环。
- Worker 不能直接调用底层 LLM provider；只能通过 `AgentLoop.run()` / `AgentLoop.inject()` / `AgentLoop.abort()`。
- Worker 必须复用 server 已初始化的 `ToolRegistry` 和 LLM provider，避免 Team 模式和普通 chat 模式出现两套工具/模型配置。
- Team 模式的 `team_messages` 是事实记录，`Conversation` / `EphemeralConversation` 只是某次 `AgentLoop` 执行的上下文窗口。

Worker 循环：

```text
1. 检查发给自己的 control 消息
2. 检查发给自己的 agent_dm 消息
3. 检查 assigned 给自己的任务
4. 检查 approved / rejected 后需要恢复的任务
5. 没有任务和消息则 idle
```

任务执行 prompt 应组装：

```text
<agent_soul>
SOUL.md
</agent_soul>

<agent_operating_instructions>
AGENTS.md
</agent_operating_instructions>

<task_context>
任务描述、项目、最近 team_messages、审批回复
</task_context>
```

### 给 Codex 做任务的 prompt

```text
请实现 Lovely Octopus 的 AgentWorker。

要求：
1. 新增 src/team/AgentWorker.ts。
2. 每个 active Agent 启动一个 Worker。
3. Worker 能处理发给自己的 agent_dm 消息。
4. Worker 能领取 assigned 任务并执行 AgentLoop。
5. Worker 不允许自己实现 LLM streaming、tool calling、tool result 回填；这些必须由现有 AgentLoop 负责。
6. Worker 不允许 new 第二套 ToolRegistry 或 LLM provider；必须复用 server.ts 注入的实例。
7. Worker 只负责把 Task、Agent 配置、SOUL.md、AGENTS.md、相关 team_messages 组装成 AgentLoop 输入。
8. AgentLoop 的 system prompt 必须包含 SOUL.md 和 AGENTS.md，且分块清晰。
9. 工具列表必须按 agent.yaml.tools 过滤，但过滤后的执行仍交给现有 ToolRegistry/AgentLoop。
10. 给任务 Agent 注入 report_progress 和 request_approval 工具。
11. request_approval 调用后任务进入 awaiting_approval，当前任务暂停。
12. approved/rejected 后恢复任务，把人类回复作为 user update 注入 AgentLoop。
13. 运行中如果收到普通补充消息，先落库，再在 checkpoint 调用 AgentLoop.inject()。
14. cancel/pause 控制消息可以调用 AgentLoop.abort() 或暂停任务。
15. 注入过的 team_messages 必须 markInjected，不能重复注入。
16. 补充 Worker 层测试，必要时用 mock LLMProvider。
```

### 验收标准

- AgentWorker 能从 assigned 任务启动 AgentLoop
- AgentLoop 的 prompt 中包含 `agent_soul` 和 `agent_operating_instructions`
- Agent 只能看到 `agent.yaml.tools` 允许的工具
- `report_progress` 会写 `task_logs`
- `request_approval` 会暂停任务并写审批信息
- 人类 approve 后任务能继续
- 人类 reject 后任务能收到拒绝原因并调整或取消
- 运行中的普通补充只注入一次
- cancel 能中断当前执行

### 我需要理解的重点技术和设计

- AgentWorker 是运行时，不是配置中心
- 注入消息必须先落库，再注入，避免服务重启丢消息
- checkpoint 注入比强行打断更安全
- 对发布、删除、部署等高风险动作，要依赖 `requires_approval`
- 现有 `AgentLoop.inject()` 可以复用，但不能作为唯一消息来源
- AgentWorker 是 AgentLoop 的调度器和上下文适配器，不是第二个 AgentLoop
- 如果需要新增能力，优先扩展工具、prompt 组装或消息注入点，不要复制 AgentLoop 的执行逻辑

---

## 6. Coordinator Agent 和跨 Agent 协调

### 目标

实现 Coordinator，但它不是总入口。Coordinator 只处理复杂协作、无人认领任务、失败升级、项目总结。

Coordinator 的执行边界：

- Coordinator 如果需要 LLM，也必须作为一个特殊 agent 通过现有 `AgentLoop` 执行。
- CoordinatorLoop 只负责扫描状态、确定性分配、组装 coordinator 上下文、调用 AgentLoop。
- CoordinatorTools 是普通工具集合，不能绕过 `TaskQueue` / `TeamMessageStore` 直接改事实。
- 能靠规则完成的分配、状态查询、ack、消息转发不调用 LLM。

Coordinator 负责：
- 默认入口消息
- 复杂任务拆解
- pending 任务自动分配
- failed / timeout 任务升级
- 项目频道总结
- 日报、周报、记忆整理

Coordinator 不负责：
- 拦截所有 Agent DM
- 处理明确的 `/task approve`
- 替代 TeamRouter 做简单路由
- 绕过消息表直接给 Agent 塞上下文

### 给 Codex 做任务的 prompt

```text
请实现 Lovely Octopus 的 CoordinatorTools 和 CoordinatorLoop。

要求：
1. 新增 src/team/CoordinatorTools.ts。
2. 新增 src/team/CoordinatorLoop.ts。
3. CoordinatorTools 提供 create_task、list_tasks、assign_task、delegate_task、request_approval、check_team_status、send_message_to_agent、post_to_project_channel、summarize_project_channel。
4. send_message_to_agent 必须写 team_messages，不允许绕过 TeamMessageStore。
5. post_to_project_channel 必须写 project channel 消息。
6. CoordinatorLoop 定期扫描 pending、failed、timeout、coordinator channel 新消息、project channel 新消息。
7. pending 任务优先用 tags 和 Agent task_tags 做确定性匹配。
8. 只有复杂拆解、冲突处理、总结才调用 LLM。
9. Coordinator 也使用 agent.yaml + SOUL.md + AGENTS.md。
10. Coordinator 调用 LLM 时必须复用现有 AgentLoop、ToolRegistry、LLM provider。
11. CoordinatorLoop 不允许实现第二套工具调用循环。
12. 补充工具测试和基础 loop 测试。
```

### 验收标准

- pending 任务能自动分配给 tag 匹配的 Agent
- Agent 超过 timeout 后任务进入 failed 或升级
- coordinator channel 的新消息能被处理
- project channel 的长讨论能生成摘要
- Coordinator 发给 Agent 的消息出现在 team_messages
- Coordinator 不处理明确发给 `@coder` 的普通 DM，除非被显式请求

### 我需要理解的重点技术和设计

- Coordinator 是 Chief of Staff，不是老板
- 能确定性解决的事情不要消耗 LLM
- 跨 Agent 协调要留下消息记录，方便追踪和复盘
- 自动分配可以先用 tags，后续再加 LLM 判断
- Coordinator 的存在是为了减少管理成本，不是增加一个沟通瓶颈
- CoordinatorLoop 是调度层；Coordinator 的智能执行仍然是 AgentLoop

---

## 7. Gateway 和飞书集成

### 目标

把现有 WebSocket / Feishu 入口接到 TeamRouter，而不是直接接到某个 AgentLoop。

模式边界：

- 普通 chat 仍走 `SessionRouter -> AgentLoop`。
- Team 模式走 `TeamRouter -> TeamMessageStore/TaskQueue -> AgentWorkers/CoordinatorLoop -> AgentLoop`。
- Gateway 和 FeishuAdapter 只能选择入口和传输 ack，不应该直接调用 LLM 或实现业务路由。
- 两种模式可以共享同一个 LLM provider、ToolRegistry、SkillManager、McpManager，但不要共享消息路由状态。

Gateway 新增协议：

```text
Client -> Server:
  route_human_message
  send_agent_dm
  send_project_message
  bind_project_channel
  list_project_channels
  get_project_channel
  get_team_messages
  list_tasks
  approve_task
  reject_task
  cancel_task

Server -> Client:
  human_message_routed
  team_message_added
  project_channels_list
  project_channel_loaded
  task_updated
  approval_needed
```

飞书处理：

```text
Feishu webhook -> parse message -> TeamRouter.routeHumanMessage()
-> 立刻 HTTP 200
-> 通过飞书主动发送 ack
-> 后台任务完成后再推送结果
```

### 给 Codex 做任务的 prompt

```text
请把 Lovely Octopus 的 TeamRouter 接入 Gateway 和 Feishu。

要求：
1. 扩展 src/gateway/protocol.ts 和 web/src/types/protocol.ts。
2. GatewayServer 支持 route_human_message、send_agent_dm、send_project_message、bind_project_channel、list_project_channels、get_project_channel、get_team_messages。
3. server.ts 初始化 AgentRegistry、TaskQueue、TeamMessageStore、ProjectChannelStore、AgentWorkers、CoordinatorLoop、TeamRouter。
4. FeishuAdapter 收到消息后调用 TeamRouter，而不是等待 SessionRouter.handleChat 完整跑完。
5. 飞书 webhook 尽快返回 HTTP 200。
6. TeamRouter 返回 ack 后，通过 FeishuAdapter 主动发 ack。
7. 长任务完成、审批请求、重要进度通过后续消息推送。
8. 保留现有普通 chat session 能力，不要破坏已有 CLI/Web UI 聊天。
9. 补充协议解析和 Gateway handler 测试。
```

### 验收标准

- WebSocket 能发 `route_human_message` 并收到 `human_message_routed`
- 飞书消息不会等待完整 AgentLoop 才响应 webhook
- 飞书能收到 ack
- 项目频道消息能推送给在线 Web UI
- 审批请求能推送飞书和 Web UI
- 现有 `/chat` 或普通会话功能不回归

### 我需要理解的重点技术和设计

- Gateway 是传输层，不应该包含复杂业务判断
- FeishuAdapter 是外部适配器，不应该直接操作任务状态机太多
- TeamRouter 是人类入口的统一业务层
- webhook 要快进快出，长任务必须异步
- 现有 SessionRouter 仍可保留，用于普通聊天；Lovely Octopus 是新增团队模式
- 路由层隔离、执行层复用：这是控制维护成本的核心约束

---

## 8. Mission Control 前端

### 目标

新增 Mission Control 页面，让人类能直接管理团队、任务、频道和审批。

页面：

```text
/mission-control
/mission-control/tasks
/mission-control/channels
/mission-control/projects
/mission-control/team
/mission-control/calendar
/mission-control/memory
/mission-control/docs
```

优先做：
- Tasks 看板
- Channels 时间线
- Team 管理

### 给 Codex 做任务的 prompt

```text
请实现 Mission Control 前端基础页面。

要求：
1. 在 web 中新增 /mission-control 路由组。
2. 优先实现 tasks、channels、team 三个页面。
3. tasks 页面展示 Pending / Running / Awaiting Approval / Completed 看板。
4. awaiting approval 卡片提供 approve / reject。
5. channels 页面左侧显示项目频道和 Agent DM，右侧显示 team_messages 时间线。
6. channels 输入框支持 @agent、#project、/task 命令。
7. team 页面展示 Agent 列表，支持查看 agent.yaml、SOUL.md、AGENTS.md。
8. 通过现有 WebSocket client 调用新增 Gateway 协议。
9. UI 遵循现有 web 目录风格，不引入无关设计系统。
10. 补充关键组件测试或至少保证 build/typecheck 通过。
```

### 验收标准

- 能看到任务看板
- 能审批任务
- 能看到项目频道和 Agent DM
- 能向 `@agent` 或 `#project` 发消息
- 能查看 Agent 的三文件配置
- WebSocket 断线或请求失败有明确状态
- 页面刷新后能从后端恢复数据

### 我需要理解的重点技术和设计

- Web UI 是管理面，不应该复制业务逻辑
- 项目频道的真实数据来自 `team_messages`
- 任务状态来自 `TaskQueue`
- 前端输入命令不需要自己完全解析，最终以后端 TeamRouter 为准
- Mission Control 是先实用，Visual 动画后做

---

## 9. 启动流程和生命周期

### 目标

把 Lovely Octopus 模块接入 server 启动、停止和清理流程。

新增启动顺序：

```text
1. Database
2. ToolRegistry
3. SkillManager
4. McpManager
5. SessionRouter + AgentLoop
6. CronScheduler + EventWatcher
7. HealthChecker
8. GatewayServer
9. AgentRegistry
10. TaskQueue
11. TeamMessageStore
12. ProjectChannelStore
13. AgentWorkers
14. CoordinatorLoop
15. TeamRouter
16. FeishuAdapter -> TeamRouter
```

依赖注入边界：

- `ToolRegistry`、LLM provider、SkillManager、McpManager 只能初始化一次，并注入给 `SessionRouter`、`AgentWorkers`、`CoordinatorLoop` 复用。
- `AgentWorkers` 和 `CoordinatorLoop` 不应该在内部自己创建新的全局执行依赖。
- server.ts 负责组装生命周期，模块本身只暴露 start/stop/dispose，不偷偷启动后台循环。

### 给 Codex 做任务的 prompt

```text
请把 Lovely Octopus 的服务生命周期接入 server.ts。

要求：
1. server.ts 初始化 AgentRegistry、TaskQueue、TeamMessageStore、ProjectChannelStore。
2. 为每个 active Agent 创建 AgentWorker。
3. 启动 CoordinatorLoop。
4. AgentWorkers 和 CoordinatorLoop 必须复用 server 已创建的 LLM provider、ToolRegistry、SkillManager、McpManager。
5. 创建 TeamRouter，并注入 AgentRegistry、TaskQueue、TeamMessageStore、ProjectChannelStore、AgentWorkers、CoordinatorLoop。
6. GatewayServer 和 FeishuAdapter 使用 TeamRouter。
7. cleanup 时停止 AgentWorkers 和 CoordinatorLoop。
8. 启动日志打印 Lovely Octopus 团队状态、任务统计、项目频道数量。
9. 如果 agents 目录不存在，创建默认 coordinator 和 coder 模板。
10. 如果某个 Agent 配置错误，不能导致整个服务崩溃；标记 unavailable 并打印原因。
```

### 验收标准

- server 启动时能加载 Agent 团队
- 配置错误的 Agent 不影响其他 Agent
- cleanup 能停止所有 Worker 和 CoordinatorLoop
- 启动日志能看到 active Agent、任务统计、项目频道统计
- Feishu enabled 时 webhook 接到 TeamRouter
- Feishu disabled 时本地 Web UI 仍可用

### 我需要理解的重点技术和设计

- 生命周期要集中在 server.ts，避免模块自己偷偷启动后台循环
- Worker 和 loop 都需要 stop/dispose
- Agent 配置错误要隔离，不能拖垮整个系统
- 默认模板能降低首次使用门槛
- server.ts 是唯一的执行依赖装配层，避免 Team 模式悄悄长出第二套运行时

---

## 10. 推荐实施顺序

### 目标

降低实现风险，按可验收的小块推进。

### 给 Codex 做任务的 prompt

```text
请按以下顺序实施 Lovely Octopus，不要一次性做完整系统：

Phase 1:
1. AgentRegistry
2. TaskQueue
3. TeamMessageStore
4. ProjectChannelStore

Phase 2:
5. TeamRouter
6. AgentWorker 的最小任务执行
7. 人类消息 checkpoint 注入
8. 验证 Team 模式执行复用现有 AgentLoop/ToolRegistry/LLM provider

Phase 3:
9. CoordinatorTools
10. CoordinatorLoop
11. server.ts 生命周期接入

Phase 4:
12. Gateway 协议扩展
13. Feishu 异步 ack
14. Mission Control tasks/channels/team

每个 Phase 完成后都要运行类型检查和相关测试，并给出剩余风险。
```

### 验收标准

- Phase 1 完成后，可以用测试直接操作配置、任务、消息、频道
- Phase 2 完成后，可以把一条人类消息路由给 Agent 并执行任务
- Phase 2 完成后，测试必须证明 AgentWorker 没有绕过 AgentLoop/ToolRegistry/LLM provider
- Phase 3 完成后，Coordinator 能分配 pending 任务和处理默认入口
- Phase 4 完成后，飞书和 Web UI 能使用团队模式

### 我需要理解的重点技术和设计

- 先做持久化和状态机，再做 Agent 智能
- 先做 TeamRouter，再做 Coordinator，避免一开始就把所有事交给 LLM
- 先做文本和看板，再做 Visual 动画
- 每个阶段都应该可独立验证
- 如果后续实现卡住，优先保住任务状态、消息落库、人工审批这三件事
