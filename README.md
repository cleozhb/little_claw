# little_claw

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

# FOUNDATION — Agent core
## 1 Minimal agent
Bun + TS setup, LLM streaming client, multi-turn conversation REPL

## 2 Tool calling (ReAct loop)
Tool interface & registry, built-in tools, AgentLoop, LLM Provider abstraction

## 3 Persistence & sessions
SQLite, conversation save/restore, session CRUD, auto title generation

# INFRASTRUCTURE — Client-server & resilience
## 4 Gateway
WebSocket server, protocol, SessionRouter, CLI as client, server/client split

## 5 Heartbeat & health monitoring
Periodic health checks (WS, MCP, LLM API), auto-reconnect, status reporting

# EXTENSIBILITY — Plugin & scheduling
## 6 Local skill plugin system
Skill interface with lifecycle, SkillLoader, SkillManager, example WeatherSkill

## 7 MCP client support
MCP client (JSON-RPC over stdio), McpToolAdapter, config-driven connections

## 8 Cron scheduler & event watcher
Cron jobs, event watchers, implemented as built-in skills, push through Gateway

# INTELLIGENCE — Agent capabilities
## 9 Sub-agent mechanism
AgentConfig, SpawnAgentTool, recursive delegation, progress streaming

## 10 Memory system
Short-term window, long-term vector search, context assembler, token budgeting

# INTERFACE — User-facing
## 11 Web UI
Next.js + React + Tailwind, chat interface, real-time streaming, tool & sub-agent rendering

