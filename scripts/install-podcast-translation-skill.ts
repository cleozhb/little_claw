import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

type SkillEntry = {
  enabled?: boolean;
  env?: Record<string, string>;
};

type LittleClawConfig = {
  skills?: {
    tokenBudget?: number;
    pinned?: string[];
    entries?: Record<string, SkillEntry>;
  };
  [key: string]: unknown;
};

const skillName = "podcast-translation-skill";
const repoRoot = resolve(import.meta.dir, "..");
const sourceSkill = join(
  repoRoot,
  ".little_claw",
  "skills",
  skillName,
  "SKILL.md",
);
const targetSkill = join(
  homedir(),
  ".little_claw",
  "skills",
  skillName,
  "SKILL.md",
);
const configPath = join(homedir(), ".little_claw", "config.json");

const podcastToolDirArg = process.argv.slice(2).find((arg) => arg !== "--");
const podcastToolDir =
  podcastToolDirArg ??
  process.env.PODCAST_TOOL_DIR ??
  "/home/zhanghuibin02/code/podcast_translation";

async function readJson(path: string): Promise<LittleClawConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return {};
  }

  return JSON.parse(await file.text()) as LittleClawConfig;
}

mkdirSync(dirname(targetSkill), { recursive: true });
mkdirSync(dirname(configPath), { recursive: true });

await Bun.write(targetSkill, await Bun.file(sourceSkill).text());

const config = await readJson(configPath);
config.skills ??= {};
config.skills.tokenBudget ??= 20000;
config.skills.pinned ??= [];
config.skills.entries ??= {};
config.skills.entries[skillName] ??= {};
config.skills.entries[skillName].env = {
  ...config.skills.entries[skillName].env,
  PODCAST_TOOL_DIR: podcastToolDir,
  LITTLE_CLAW_SHELL_ALLOWED_ROOTS: podcastToolDir,
};

await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`Installed ${skillName} to ${targetSkill}`);
console.log(`Updated ${configPath}`);
