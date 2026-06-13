import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../../src/team/AgentRegistry.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "little-claw-agents-"));
  tempDirs.push(dir);
  return dir;
}

function writeAgent(
  baseDir: string,
  name: string,
  yaml: string,
  soul = "# Soul\nTone rules.\n",
  agents = "# Agent Operating Instructions\nWork rules.\n",
): void {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), yaml, "utf8");
  writeFileSync(join(dir, "SOUL.md"), soul, "utf8");
  writeFileSync(join(dir, "AGENTS.md"), agents, "utf8");
}

function validYaml(name: string, status = "active"): string {
  return `name: ${name}
display_name: ${name}
role: Test role
status: ${status}
aliases:
  - ${name}-alias
tools:
  - shell
skills:
  - test-skill
task_tags:
  - test
cron_jobs:
  - cron: "0 8 * * *"
    prompt: "Run daily task"
requires_approval:
  - publish
max_concurrent_tasks: 2
max_tokens_per_task: 50000
timeout_minutes: 30
`;
}

describe("AgentRegistry", () => {
  test("loads agent.yaml, SOUL.md, and AGENTS.md", () => {
    const baseDir = makeBaseDir();
    writeAgent(
      baseDir,
      "coder",
      validYaml("coder"),
      "# Soul\nCoder tone.\n",
      "# Agent Operating Instructions\nCoder process.\n",
    );

    const registry = new AgentRegistry(baseDir);
    const agents = registry.loadAll();

    expect(agents).toHaveLength(1);
    expect(agents[0]?.config.name).toBe("coder");
    expect(agents[0]?.config.aliases).toEqual(["coder-alias"]);
    expect(agents[0]?.config.tools).toEqual(["shell"]);
    expect(agents[0]?.soul).toContain("Coder tone");
    expect(agents[0]?.operatingInstructions).toContain("Coder process");
    expect(agents[0]?.status).toBe("idle");
  });

  test("filters active agents", () => {
    const baseDir = makeBaseDir();
    writeAgent(baseDir, "active-agent", validYaml("active-agent", "active"));
    writeAgent(baseDir, "paused-agent", validYaml("paused-agent", "paused"));
    writeAgent(baseDir, "disabled-agent", validYaml("disabled-agent", "disabled"));

    const registry = new AgentRegistry(baseDir);
    registry.loadAll();

    expect(registry.listActive().map((agent) => agent.config.name)).toEqual(["active-agent"]);
    expect(registry.get("paused-agent")?.status).toBe("paused");
    expect(registry.get("disabled-agent")?.status).toBe("paused");
  });

  test("records load errors for invalid agents without failing all loading", () => {
    const baseDir = makeBaseDir();
    writeAgent(baseDir, "coder", validYaml("coder"));
    const brokenDir = join(baseDir, "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "agent.yaml"), validYaml("broken"), "utf8");
    writeFileSync(join(brokenDir, "SOUL.md"), "# Soul\n", "utf8");
    mkdirSync(join(baseDir, ".bad-name"), { recursive: true });

    const registry = new AgentRegistry(baseDir);
    const agents = registry.loadAll();

    expect(agents.map((agent) => agent.config.name)).toEqual(["coder"]);
    expect(registry.getLoadErrors()).toHaveLength(2);
    expect(registry.getLoadErrors().map((error) => error.name).sort()).toEqual([
      ".bad-name",
      "broken",
    ]);
    expect(registry.getLoadErrors().find((error) => error.name === "broken")?.message).toContain(
      "Missing required AGENTS.md",
    );
  });

  test("create writes missing files but does not overwrite existing files", () => {
    const baseDir = makeBaseDir();
    const coderDir = join(baseDir, "coder");
    mkdirSync(coderDir, { recursive: true });
    writeFileSync(join(coderDir, "SOUL.md"), "# Soul\nKeep me.\n", "utf8");

    const registry = new AgentRegistry(baseDir);
    const agent = registry.create("coder", {
      config: {
        name: "coder",
        role: "Writes code",
        tools: ["shell"],
        task_tags: ["code"],
      },
      soul: "# Soul\nOverwrite attempt.\n",
      operatingInstructions: "# Agent Operating Instructions\nProcess.\n",
    });

    expect(agent.config.name).toBe("coder");
    expect(readFileSync(join(coderDir, "SOUL.md"), "utf8")).toContain("Keep me");
    expect(readFileSync(join(coderDir, "AGENTS.md"), "utf8")).toContain("Process");
  });

  test("installs repository default agents without overwriting local edits", () => {
    const baseDir = makeBaseDir();
    const registry = new AgentRegistry(baseDir);

    const installed = registry.installDefaultAgents();

    expect(installed.map((agent) => agent.config.name).sort()).toEqual([
      "assistant",
      "coder",
      "coordinator",
      "podcast-curator",
      "tinker",
      "vc-analyst",
    ]);
    expect(existsSync(join(baseDir, "assistant", "agent.yaml"))).toBe(true);
    expect(readFileSync(join(baseDir, "assistant", "AGENTS.md"), "utf8")).toContain(
      "默认的对话入口",
    );
    expect(existsSync(join(baseDir, "coordinator", "agent.yaml"))).toBe(true);
    expect(readFileSync(join(baseDir, "coordinator", "SOUL.md"), "utf8")).toContain(
      "操作清晰",
    );
    expect(registry.get("coordinator")?.config.default_project).toBe("team-ops");

    writeFileSync(join(baseDir, "coordinator", "SOUL.md"), "# Soul\nLocal edit.\n", "utf8");
    registry.installDefaultAgents(["coordinator"]);

    expect(readFileSync(join(baseDir, "coordinator", "SOUL.md"), "utf8")).toContain("Local edit");
  });

  test("syncs repository default agent config into existing local agent yaml", () => {
    const baseDir = makeBaseDir();
    writeAgent(
      baseDir,
      "coordinator",
      `name: coordinator
display_name: Local Coordinator
role: Local coordinator role
status: paused
aliases:
  - local-coord
tools:
  - shell
  - local_tool
task_tags:
  - local
cron_jobs:
  - cron: "0 20 * * *"
    prompt: "Local review prompt"
    key: daily-team-review
    enabled: false
  - cron: "30 9 * * 1"
    prompt: "Local weekly prompt"
    key: local-weekly
requires_approval:
  - local risky thing
max_concurrent_tasks: 1
max_tokens_per_task: 50000
timeout_minutes: 30
`,
      "# Soul\nLocal coordinator soul.\n",
    );

    const registry = new AgentRegistry(baseDir);
    const [agent] = registry.installDefaultAgents(["coordinator"]);
    const yaml = readFileSync(join(baseDir, "coordinator", "agent.yaml"), "utf8");

    expect(agent.config.status).toBe("paused");
    expect(agent.config.display_name).toBe("Local Coordinator");
    expect(agent.config.tools).toContain("create_team_schedule");
    expect(agent.config.tools).toContain("list_team_schedules");
    expect(agent.config.tools).toContain("update_team_schedule");
    expect(agent.config.tools).toContain("local_tool");
    expect(agent.config.task_tags).toContain("coordination");
    expect(agent.config.task_tags).toContain("local");
    expect(agent.config.requires_approval).toContain("change agent permissions");
    expect(agent.config.requires_approval).toContain("local risky thing");
    expect(agent.config.cron_jobs.find((job) => job.key === "daily-team-review")?.enabled).toBe(false);
    expect(agent.config.cron_jobs.find((job) => job.key === "daily-team-review")?.name).toBe("每日团队回顾");
    expect(agent.config.cron_jobs.find((job) => job.key === "local-weekly")?.prompt).toBe("Local weekly prompt");
    expect(readFileSync(join(baseDir, "coordinator", "SOUL.md"), "utf8")).toContain("Local coordinator soul");
    expect(yaml).toContain("create_team_schedule");
    expect(yaml).not.toContain("approval_rules:");
  });

  test("repository default agents use explicit stable schedule fields", () => {
    const baseDir = makeBaseDir();
    const registry = new AgentRegistry(baseDir);

    const [agent] = registry.installDefaultAgents(["coordinator"]);
    const [job] = agent.config.cron_jobs;
    const yaml = readFileSync(join(baseDir, "coordinator", "agent.yaml"), "utf8");

    expect(job?.key).toBe("daily-team-review");
    expect(job?.name).toBe("每日团队回顾");
    expect(job?.project).toBe("team-ops");
    expect(job?.tags).toContain("scheduled");
    expect(job?.max_retries).toBe(2);
    expect(job?.enabled).toBe(true);
    expect(agent.config.watchers).toEqual([]);
    expect(yaml).toContain("key: daily-team-review");
    expect(yaml).toContain("watchers: []");
  });

  test("repository tinker default is a safe isolated inspiration agent", () => {
    const baseDir = makeBaseDir();
    const registry = new AgentRegistry(baseDir);

    const [agent] = registry.installDefaultAgents(["tinker"]);
    const [job] = agent.config.cron_jobs;
    const yaml = readFileSync(join(baseDir, "tinker", "agent.yaml"), "utf8");

    expect(agent.config.name).toBe("tinker");
    expect(agent.config.default_project).toBeUndefined();
    expect(agent.config.aliases).toEqual(["tinker", "lab", "experimenter"]);
    expect(agent.config.tools).toEqual([
      "shell",
      "read_file",
      "write_file",
      "web_search",
      "memory_read",
      "memory_write",
      "context_write",
    ]);
    expect(job?.key).toBe("nightly-tinker-spark");
    expect(job?.name).toBe("夜间 Tinker 灵感");
    expect(job?.project).toBeUndefined();
    expect(job?.tags).toContain("scheduled");
    expect(job?.tags).toContain("tinker");
    expect(job?.enabled).toBe(true);
    expect(agent.config.requires_approval).toContain("modify formal project files");
    expect(agent.config.requires_approval).toContain("spend more than $5");
    expect(agent.config.approval_rules).toHaveLength(2);
    expect(agent.config.approval_rules[0]?.tool).toBe("shell");
    expect(agent.config.approval_rules[1]?.tool).toBe("write_file");
    expect(agent.config.approval_rules[1]?.field).toBe("path");
    expect(agent.config.approval_rules[1]?.pattern).toBe("^(?!(\\./)?tinker/).*");
    expect(agent.config.watchers).toEqual([]);
    expect(agent.config.max_turns).toBe(25);
    expect(agent.config.context_mode).toBe("always");
    expect(job?.prompt).toContain("task_context execution_date");
    expect(job?.prompt).toContain("tinker/runs/{execution_date}/");
    expect(job?.prompt).toContain("attempts.md");
    expect(job?.prompt).toContain("retry_count 和 max_retries");
    expect(job?.prompt).toContain("不要使用来源材料、记忆条目、项目历史或想法名称中的日期创建运行目录");
    expect(yaml).toContain("watchers: []");
  });

  test("creates a custom-named agent explicitly", () => {
    const baseDir = makeBaseDir();
    const registry = new AgentRegistry(baseDir);

    const agent = registry.create("frontend-coder", {
      config: {
        name: "frontend-coder",
        role: "Implement frontend code",
        display_name: "Frontend Coder",
        aliases: ["frontend"],
        default_project: "web",
        tools: ["read_file", "write_file", "shell"],
      },
      soul: "# Soul\nFrontend pragmatic.\n",
      operatingInstructions: "# Agent Operating Instructions\nRead the relevant code.\n",
    });

    expect(agent.config.name).toBe("frontend-coder");
    expect(agent.config.display_name).toBe("Frontend Coder");
    expect(agent.config.aliases).toEqual(["frontend"]);
    expect(agent.config.default_project).toBe("web");
    expect(readFileSync(join(baseDir, "frontend-coder", "SOUL.md"), "utf8")).toContain("pragmatic");
  });

  test("update supports config, soul, and operating instructions independently", () => {
    const baseDir = makeBaseDir();
    writeAgent(
      baseDir,
      "coder",
      validYaml("coder"),
      "# Soul\nOld soul.\n",
      "# Agent Operating Instructions\nOld process.\n",
    );

    const registry = new AgentRegistry(baseDir);
    registry.loadAll();
    const updated = registry.update("coder", {
      config: {
        status: "paused",
        aliases: ["dev"],
      },
      soul: "# Soul\nNew soul.\n",
    });

    expect(updated.config.status).toBe("paused");
    expect(updated.config.aliases).toEqual(["dev"]);
    expect(updated.soul).toContain("New soul");
    expect(updated.operatingInstructions).toContain("Old process");

    const updatedAgain = registry.update("coder", {
      operatingInstructions: "# Agent Operating Instructions\nNew process.\n",
    });
    expect(updatedAgain.operatingInstructions).toContain("New process");
  });

  test("rejects invalid agent names and name mismatches", () => {
    const baseDir = makeBaseDir();
    const registry = new AgentRegistry(baseDir);

    expect(() =>
      registry.create("../outside", {
        config: { name: "../outside", role: "Bad" },
      }),
    ).toThrow("Invalid agent name");

    expect(() =>
      registry.create("coder", {
        config: { name: "other", role: "Mismatch" },
      }),
    ).toThrow('must match directory name "coder"');
  });

  test("delete requires explicit confirmation", () => {
    const baseDir = makeBaseDir();
    writeAgent(baseDir, "coder", validYaml("coder"));

    const registry = new AgentRegistry(baseDir);
    registry.loadAll();

    expect(() => registry.delete("coder")).toThrow("requires explicit confirmation");
    expect(existsSync(join(baseDir, "coder"))).toBe(true);

    registry.delete("coder", true);
    expect(existsSync(join(baseDir, "coder"))).toBe(false);
    expect(registry.get("coder")).toBeNull();
  });
});
