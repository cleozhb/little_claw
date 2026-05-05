---
name: podcast-translation-skill
description: Use this skill when discovering podcast RSS feeds, listing podcast episodes, translating English podcast audio into Chinese audio, checking asynchronous translation status, or delivering translated podcast artifacts.
metadata:
  openclaw:
    requires:
      bins:
        - uv
---

# Podcast Translation Skill

Use the Python CLI through `shell`. All commands must run from `$PODCAST_TOOL_DIR` and include `--json`.

Required configuration:

```bash
PODCAST_TOOL_DIR=/path/to/podcast_translation
LITTLE_CLAW_SHELL_ALLOWED_ROOTS=/path/to/podcast_translation
```

Do not hardcode an absolute repository path in commands. Do not read `.env` files directly. Rely on the skill environment injected by Little Claw.

## RSS

Find RSS feeds:

```bash
cd "$PODCAST_TOOL_DIR" && uv run podcast_tool rss find --query "<podcast name or keywords>" --json
```

List episodes:

```bash
cd "$PODCAST_TOOL_DIR" && uv run podcast_tool episodes list --rss-url "<rss_url>" --limit 10 --json
```

## Translation

Start translation only after explicit human approval.

Start from RSS episode:

```bash
cd "$PODCAST_TOOL_DIR" && uv run podcast_tool translate start --rss-url "<rss_url>" --episode-id "<episode_id>" --target-lang "zh-CN" --voice-clone true --json
```

Start from direct audio URL:

```bash
cd "$PODCAST_TOOL_DIR" && uv run podcast_tool translate start --audio-url "<audio_url>" --title "<episode title>" --target-lang "zh-CN" --voice-clone true --json
```

After start returns, record `job_id`. Never wait for the full translation in a single shell call.

## Status

Poll one translation task:

```bash
cd "$PODCAST_TOOL_DIR" && uv run podcast_tool translate status --job-id "<job_id>" --json
```

List active translation tasks:

```bash
cd "$PODCAST_TOOL_DIR" && uv run podcast_tool translate list --status active --json
```

Cancel a translation task:

```bash
cd "$PODCAST_TOOL_DIR" && uv run podcast_tool translate cancel --job-id "<job_id>" --json
```

When a task is `completed`, deliver `audio_zh`, `shownotes_zh`, `transcript_en`, and `transcript_zh` from `artifacts`.

When a task is `failed`, report `error.code`, `error.message`, and whether `error.retryable` is true.

For scheduled polling, report only `completed`, `failed`, or `cancelled` tasks to the user. For `queued` or `running`, update project state quietly.
