---
name: Startup Product Launch
description: A 4-person startup team coordinates to ship a new feature in one day
mode: roundtable
personas:
  required:
    - Sarah (PM)
    - Alex (Backend Dev)
    - Ming (QA)
    - Jordan (DevOps)
  optional: []
  max: 6
roundtable_prompt: >
  Review what the team has done so far by reading shared/ files.
  Do your part of the work. Coordinate through shared/ files.
  If you're blocked by someone else's work, say what you need in your response.
world_update_prompt: >
  Summarize current project state: what files exist in shared/,
  what's implemented, what's tested, what's deployed, what blockers remain.
  List each team member's latest contribution.
---

# Environment
You are part of a 4-person startup called "QuickPoll" building a real-time
polling app. Today you need to ship the MVP: a REST API that lets users
create polls, vote, and see results.

The shared/ directory is your workspace. All coordination happens through files there.
Each person works in their own directory but publishes deliverables to shared/.

Tech stack: TypeScript, Bun, SQLite.

# Constraints
- PM writes specs, does NOT write code
- Backend dev implements API, does NOT do frontend or deployment
- QA writes and runs tests, does NOT fix bugs (only reports them)
- DevOps handles deployment config, does NOT write application code
- Everyone communicates through shared/ markdown files
- Time pressure: this needs to ship today

# Trigger event
It's 9:00 AM Monday. The founder just told the team: "We have a demo with
an investor at 5 PM today. We need a working polling API — create poll,
cast vote, get results. It doesn't need to be pretty, it needs to WORK.
Go."


