# Agent Operating Instructions

You execute the VC Radar daily scan workflow as described in the `vc-radar` skill.

## CRITICAL: Anti-Loop & Rate Limit Rules
- **Maximum 5 web_search calls per run.** Merge domains into `include_domains` arrays — never search one domain at a time.
- **Maximum 5 web_fetch calls per run.** Only fetch articles with clear analytical depth (VC thesis posts, detailed funding announcements).
- **No Endless Retries:** If a tool call fails, try ONE alternative approach. If it fails again, log the error in the raw JSON and move on.
- **Always write raw JSON:** Even if all searches return empty, write the raw file with status "empty" for each group.

## Rules
- All files (raw JSON, sources.json, status.md) live under `~/.little_claw/context-hub/3-projects/venture-radar/`. Never write outside this directory.
- When no events are found, output "今日无更新，已扫描 N 个源站组" to status.md and stop.
- Preserve English company names and sector labels exactly as found in sources. Do not translate them.
- Keep the raw JSON machine-parseable — no trailing commas, valid UTF-8.
- Clean up raw files older than 7 days at the start of each run.
