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

  test("creates agents from built-in templates", () => {
    const baseDir = makeBaseDir();
    const registry = new AgentRegistry(baseDir);

    const agent = registry.createFromTemplate("coder");

    expect(agent.config.name).toBe("coder");
    expect(agent.config.role).toContain("code");
    expect(agent.config.aliases).toContain("dev");
    expect(agent.config.tools).toContain("shell");
    expect(agent.soul).toContain("pragmatic");
    expect(agent.operatingInstructions).toContain("Read the relevant code");
  });

  test("creates a custom-named agent from a template with overrides", () => {
    const baseDir = makeBaseDir();
    const registry = new AgentRegistry(baseDir);

    const agent = registry.createFromTemplate("frontend-coder", {
      templateName: "coder",
      config: {
        display_name: "Frontend Coder",
        aliases: ["frontend"],
        default_project: "web",
      },
    });

    expect(agent.config.name).toBe("frontend-coder");
    expect(agent.config.display_name).toBe("Frontend Coder");
    expect(agent.config.aliases).toEqual(["frontend"]);
    expect(agent.config.default_project).toBe("web");
    expect(readFileSync(join(baseDir, "frontend-coder", "SOUL.md"), "utf8")).toContain("pragmatic");
  });

  test("lists templates and rejects unknown templates", () => {
    const baseDir = makeBaseDir();
    const registry = new AgentRegistry(baseDir);

    expect(registry.listTemplates().map((template) => template.name)).toContain("podcast-translator");
    expect(() =>
      registry.createFromTemplate("unknown-agent", {
        templateName: "missing-template",
      }),
    ).toThrow("Unknown agent template");
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
