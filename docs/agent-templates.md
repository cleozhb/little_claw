# Agent Templates

Lovely Octopus agents live under:

```text
~/.little_claw/agents/{agent-name}/
├── agent.yaml
├── SOUL.md
└── AGENTS.md
```

`AgentRegistry` includes built-in templates for:

- `coordinator`
- `coder`
- `researcher`
- `personal-assistant`
- `podcast-translator`
- `ops-monitor`

These templates are defined in `src/team/AgentTemplates.ts` and can be installed through `AgentRegistry.createFromTemplate()` once a CLI or UI calls it.

## Minimal Manual Setup

If you want to create one manually before the CLI exists:

```bash
mkdir -p ~/.little_claw/agents/coder
```

Create `~/.little_claw/agents/coder/agent.yaml`:

```yaml
name: coder
display_name: Coder
emoji: "🐙"
color: "#4F8DF7"
role: "Implement, modify, and review code in the project"
status: active

aliases:
  - coder
  - dev
  - engineer
direct_message: true
default_project: engineering

tools:
  - read_file
  - write_file
  - shell

skills: []

task_tags:
  - code
  - bugfix
  - refactor
  - test
  - implementation

cron_jobs: []

requires_approval:
  - "push code"
  - "create pull request"
  - "delete files"
  - "run destructive shell command"

max_concurrent_tasks: 1
max_tokens_per_task: 50000
timeout_minutes: 30
```

Create `~/.little_claw/agents/coder/SOUL.md`:

```markdown
# Soul

You are direct, pragmatic, and careful.
You explain tradeoffs briefly and focus on working code.
You avoid hype and keep status updates concrete.
```

Create `~/.little_claw/agents/coder/AGENTS.md`:

```markdown
# Agent Operating Instructions

You are responsible for code changes.

## Workflow
- Read the relevant code before editing.
- Keep changes scoped to the task.
- Preserve existing style and local patterns.
- Run focused tests or type checks when possible.
- Report changed files and verification results.

## Failure Handling
- If tests fail, inspect the failure and fix task-related issues.
- If a failure appears unrelated, report it clearly.
- Ask for approval before destructive commands or external publishing.
```

## Field Guide

- `name`: must match the directory name.
- `display_name`: human-readable name for UI.
- `aliases`: names TeamRouter can match, such as `@coder` or `@dev`.
- `direct_message`: whether humans can talk directly to this agent.
- `default_project`: optional project channel used when no explicit project is given.
- `tools`: allowlist of tools this agent may use.
- `skills`: skills to associate with this agent.
- `task_tags`: tags used by TeamRouter and Coordinator for task matching.
- `cron_jobs`: autonomous scheduled prompts.
- `requires_approval`: operations that need human approval.
- `max_concurrent_tasks`: per-agent concurrency limit.
- `max_tokens_per_task`: token budget for a task.
- `timeout_minutes`: timeout for one task run.
