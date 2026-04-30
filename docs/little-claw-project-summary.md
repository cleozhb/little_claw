# little_claw — AI Agent Platform 项目总结

## 项目背景
- 作者：后端工程师，熟悉 Go/C++/Python，LangGraph 实战经验，TS 新手
- 目标：构建一个类似 OpenClaw 的 AI Agent 平台，用于学习 AI 应用开发
- 技术栈：Bun + TypeScript（后端）、Next.js + React + Tailwind + shadcn/ui（前端）
- LLM Provider：OpenAI（已做 Provider 抽象，可切换 Anthropic）
- 数据库：SQLite（bun:sqlite）
- 项目独特卖点：多 Agent 社会模拟引擎（思想家圆桌、政策反应模拟、社会学实验）

---

## 已完成阶段（1-10）

### 阶段 1：最小 Agent
- Bun + TS 项目，LLM 流式客户端，多轮对话 REPL

### 阶段 2：Tool Calling & ReAct 循环
- Tool 接口 & ToolRegistry，内置工具（read_file, write_file, shell）
- AgentLoop 实现 ReAct 循环（think → act → observe → loop）
- LLM Provider 抽象层（支持 OpenAI + Anthropic，统一内部消息格式）

### 阶段 3：持久化 & Session 管理
- SQLite 数据库，对话历史保存/恢复，Session CRUD
- 自动生成 Session 标题

### 阶段 4：Gateway
- WebSocket server（Bun.serve），通信协议（JSON over WS）
- SessionRouter（per-session 并发排队），CLI 改造为 WebSocket 客户端
- server/client 分离入口（bun run server / bun run cli / bun run dev）

### 阶段 5：Heartbeat & 健康监控
- HealthChecker（LLM API / WebSocket / Client 连接检测）
- 自动重连，GET /health HTTP 端点
- 注意：checkAll 已修复为 Promise.allSettled

### 阶段 6：Skill 系统（兼容 OpenClaw SKILL.md）
- SKILL.md 解析器（YAML frontmatter + Markdown body）
- Gating 依赖检查（env / bins / anyBins / config）
- System Prompt 注入（XML 格式，带 token 预算控制）
- ShellTool 支持 cwd（Skill 目录）和环境变量注入
- 兼容 ClawHub 13000+ Skills
- TS Skill 作为高级扩展保留

### 阶段 7：MCP 客户端
- McpClient（JSON-RPC 2.0 over stdio，spawn 子进程）
- McpToolAdapter（MCP 工具 → Tool 接口桥接）
- McpManager（生命周期管理，config.json 驱动）
- 三层工具体系：Built-in + SKILL.md + MCP

### 阶段 8：Cron & Event Watcher
- CronScheduler（cron 表达式，每分钟检查，持久化到 SQLite）
- EventWatcher（shell 命令检查条件，cooldown 防重复）
- 作为内置工具暴露（manage_cron, manage_watcher）
- 触发后注入 AgentLoop 消息队列，通过 Gateway 推送

### 阶段 9：Sub-Agent 机制
- AgentConfig 预设（MAIN / CODER / PLANNER / RESEARCHER）
- SpawnAgentTool（agent_type + task + context）
- 事件冒泡：Sub-Agent → SpawnAgentTool 回调 → Main AgentLoop yield → Gateway
- Sub-Agent 不能再 spawn Sub-Agent（防递归）
- Sub-Agent 结果超长时做摘要压缩（LLM 摘要，fallback 截断）
- 已知限制：当前串行执行多个 spawn，不支持并行（已分析改动方案，记录在 Known Limitations）

### 阶段 10：Memory 系统
- OpenClaw 风格文件记忆：SOUL.md（身份，只读）、USER.md（偏好）、MEMORY.md（长期知识）、memory/YYYY-MM-DD.md（每日日志）
- 向量检索层：embedding + 余弦相似度（SQLite 存储）
- Context Assembler 拼接顺序：System prompt → SOUL.md → USER.md → MEMORY.md → 向量检索结果 → Skill 指令 → 对话历史 → 新消息
- TokenBudget：改进版估算（英文/4 + 中文*1.5），裁剪优先级从 Skill 和长期记忆开始砍
- memory_write 工具：Agent 主动写入，4 种触发条件（决策/完成/事实/问题）
- MEMORY.md Agent 可写但强制追加不覆盖，写入前自动备份
- 增量摘要：每 10 轮触发，session 切换时触发

### 额外增强
- Abort 机制：Ctrl+C 中断 AgentLoop，AbortController 取消 fetch，kill 子进程
- Inject 机制：运行中注入用户指令，附加到 tool_result 消息末尾，每轮循环都检查队列
- Sub-Agent context 压缩和 system prompt 调优

---

## 待完成阶段（11-12）

### 阶段 11：Web UI
- Next.js + React + Tailwind + shadcn/ui
- 两个页面：/chat（普通对话）和 /simulation（模拟模式）
- 聊天页面：左侧 session 列表 + 右侧对话区域（流式渲染、ToolCallCard 折叠/展开、SubAgentCard、MemoryRecallBanner）
- WebSocket 连接层 + useChat / useSessions hooks
- 支持 Markdown 渲染（react-markdown）

### 阶段 12：多 Agent 模拟引擎

#### 核心概念
- **Persona**：角色定义（~/.little_claw/personas/*.md）
- **Scenario**：场景定义（~/.little_claw/scenarios/*.md）
- **SimulationRunner**：执行引擎

#### Persona 配置格式
```markdown
---
name: Elon Musk
role: CEO of Tesla & SpaceX, owner of X
emoji: 🚀
tags:
  - tech-leader
  - entrepreneur
---

# Identity
You are Elon Musk...

# Values & priorities
- First principles thinking above all
- ...

# Knowledge & expertise
- Deep technical knowledge in physics...

# Behavioral tendencies
- Speak bluntly, sometimes controversially
- ...

# Communication style
- Short, punchy sentences
- ...
```

#### Scenario 配置格式
```markdown
---
name: AI Regulation Response
description: US gov announces strict AI regulation
mode: parallel_then_roundtable
rounds: 3  # 可选，不设则由用户手动控制
parallel_prompt: >
  Give your immediate reaction from your company's perspective.
roundtable_prompt: >
  Address their points directly. Where do you agree/disagree?
---

# Environment
The year is 2026. The US government has just announced...

# Constraints
Each participant responds from their company's actual position...

# Trigger event
The bill passed 30 minutes ago...
```

#### 三种执行模式
1. **Parallel**：真并行（Promise.allSettled），各 Agent 独立反应，看不到彼此
2. **Roundtable**：顺序发言，每个 Agent 通过 transcript 看到之前所有人的发言
3. **Free**：自由互动，维护 worldState，每轮每人看到环境状态 + 所有人上一轮行动

#### transcript 机制
- 中心化的"会议记录"字符串，由 Runner 维护
- 每个 Agent 发言完追加到 transcript
- 下一个 Agent 发言时把 transcript 作为 context 传入
- 超长时做摘要压缩

#### Thinking 机制
- Persona system prompt 中要求输出 [THINKING]...[/THINKING] 标签
- THINKING 部分只发给前端控制台显示，不加入 transcript
- 公开发言部分加入 transcript

#### ArgumentExtractor
- 每轮结束后 LLM 提取论点结构
- 输出 ArgumentNode[]：{ topic, description, supporters, opposers, consensusLevel, status }

#### 用户参与设计（最新讨论）
- 用户既是 Moderator（控制流程）又可以是 Participant（参与发言）
- 每轮结束后 Runner 暂停，yield round_end_waiting 事件
- 用户三种选择：
  - nextRound()：沉默旁观，继续下一轮
  - speakThenNextRound(message)：自己发言后继续，发言以 [You] 身份加入 transcript
  - endSimulation()：结束并生成总结
- 不预设固定轮数，用户完全掌控何时结束

#### 三栏 UI 设计
- **左栏：Argument Map**——实时论点结构，共识/冲突可视化，Consensus Strength 横条，新论点黄色高亮
- **中栏：Discussion Transcript**——按轮次分段，每个 Persona 有头像+颜色，流式输出光标，Moderator 发言蓝色边框，用户发言蓝色标注 [You]
- **右栏：Control Panel**——Scenario 信息，Agent 列表（齿轮编辑 SOUL.md，点击名字展开 thinking），Moderator 输入区（Speak & continue / Next round / End），Quick actions（Cross-debate / Find consensus / Summarize）

#### 轮间等待状态
- round_end_waiting 时右栏输入区激活
- 中栏显示分隔线 "Round N complete — waiting for your decision..."
- Agent 发言中按钮置灰

---

## 关键设计决策记录

### 为什么选 TS 而非 Python
- AI 应用本质是 I/O 编排，Node.js 事件循环天然适合
- 类型安全在 AI 应用中格外重要（94% LLM 生成错误是类型相关）
- 前后端一致性，Gateway 协议类型共享
- Python 在模型训练/数据处理更强，但应用层 TS 更合适

### 为什么不用框架（LangChain 等）
- 理解每一层在做什么，调试和定制无障碍
- inject、模拟引擎等需求超出框架预设
- 框架抽象层厚，出问题难排查
- 学习项目需要理解底层而非调 API

### SKILL.md 优先于 TS Skill
- 兼容 ClawHub 13000+ 现成 Skills
- 门槛低（写 Markdown 不写代码）
- 语言无关（Skill 可以调 Python/Go/Bash 脚本）
- MCP + SKILL.md 覆盖绝大多数场景

### OpenClaw 风格文件记忆 vs 纯向量数据库
- 文件是真相来源，人可读可编辑可 git 版本控制
- 向量数据库是检索层，索引文件内容
- 四层记忆：SOUL.md（身份）→ USER.md（偏好）→ MEMORY.md（长期知识）→ 每日日志（原始记录）

### Sub-Agent 串行 vs 并行
- 当前串行执行，已知限制
- 并行需要：工具执行改 Promise.allSettled + 事件路由 per-instance ID + 客户端多路渲染
- 模拟引擎的 Parallel 模式已支持真并行

---

## 项目目录结构概览
```
little_claw/
├── src/
│   ├── main.ts, server.ts, cli.ts    # 入口
│   ├── llm/                           # LLM Provider 抽象
│   ├── core/                          # AgentLoop, Conversation, Repl
│   ├── tools/builtin/                 # 内置工具
│   ├── gateway/                       # WebSocket server, SessionRouter, HealthChecker
│   ├── db/                            # SQLite 数据库
│   ├── skills/                        # SKILL.md 解析, SkillManager
│   ├── mcp/                           # MCP 客户端
│   ├── scheduler/                     # Cron, EventWatcher
│   ├── agents/                        # AgentConfig 预设
│   ├── memory/                        # VectorStore, SummaryGenerator, MemoryManager
│   ├── simulation/                    # Persona, Scenario, SimulationRunner, ArgumentExtractor
│   ├── config/                        # 配置管理
│   └── types/                         # 共享类型定义
├── web/                               # Next.js 前端（待完成）
├── skills-examples/                   # 示例 Skill
└── ~/.little_claw/
    ├── config.json                    # 主配置
    ├── data.db                        # SQLite 数据库
    ├── SOUL.md                        # Agent 身份
    ├── USER.md                        # 用户偏好
    ├── memory/
    │   ├── MEMORY.md                  # 长期知识
    │   └── YYYY-MM-DD.md             # 每日日志
    ├── skills/                        # SKILL.md Skills
    ├── personas/                      # 模拟 Persona 配置
    └── scenarios/                     # 模拟 Scenario 配置
```
