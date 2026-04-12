---
name: Resource Crisis
description: A community of 5 people faces severe resource shortage after a natural disaster
mode: free
response_style: rapid
personas:
  required:
    - Mayor Chen
    - Nurse Lin
    - Tony
  optional:
    - Yuki
    - Old Wang
  max: 8
roundtable_prompt: ""
world_update_prompt: >
  Update the world state based on all agents' actions this round.
  Rules:
  - Resources taken by one person are no longer available to others
  - Food spoils: perishable items lose 20% quantity each round
  - Shared resources in community_pool are available to everyone
  - If someone hoards, others may notice and react next round
  - Weather gets colder each round (affects survival needs)
  - Record any trades, conflicts, or cooperation that occurred
  Write the updated state as structured markdown to shared/worldState.md
completion_hint: >
  Say [DONE] only when the community has achieved ALL of these:
  - A rationing plan is agreed upon and written to shared/
  - Water purification method is established
  - Shelter is weatherproofed for the incoming rain
  - A communication plan with the outside exists
  Individual survival does not count — the GROUP must have a viable plan.
  You may say [SKIP] if you're waiting for others to respond to your proposal.
  Do NOT say [DONE] before round 3 — real crises take time to coordinate.
---

# Environment
A severe earthquake hit a small mountain town three days ago.
Roads are blocked, no outside help expected for at least 5 more days.
Power is out. Running water stopped yesterday.

The community center (shared/ directory) is the gathering point.
shared/worldState.md tracks all known resources and conditions.

Each person has their own shelter (their private directory) where
they can store personal supplies. Items in your private directory
are yours alone — others cannot see or take them.

Items placed in shared/community_pool/ are available to everyone.

# Constraints
- Each person can perform up to 2 ACTIONS per round
- Actions include: search for resources (shell command to "discover" items),
  move items between personal and shared storage (write_file),
  trade with others (write to shared/trades.md),
  build something (write a plan or structure to a file)
- You can ONLY see: your own directory, shared/, and worldState.md
- You CANNOT access other people's private directories
- All trades must be written to shared/trades.md to be valid
- Lying is allowed — you can claim to have more or less than you do

# Initial World State
Write this to shared/worldState.md at simulation start:

## Day 3 After Earthquake — Morning

### Weather
Temperature: 8°C, dropping 2°C per round. Rain expected.

### Known Community Resources (shared/community_pool/)
- Rice: 5 kg (feeds ~10 meals)
- Bottled water: 12 bottles
- Canned food: 6 cans
- First aid kit: 1 (basic supplies)
- Flashlights: 2 (batteries low)
- Tarp: 1 large

### Infrastructure
- Community center: standing, minor damage, no heat
- Well behind center: accessible but water needs boiling
- Generator: found but needs fuel
- Radio: broken, might be repairable

### Known Needs
- Water purification (boiling requires fuel/fire)
- Shelter weatherproofing (rain coming)
- Food rationing plan
- Communication with outside

### People Status
- All 5 members physically okay
- Morale: anxious but cooperative (so far)


