import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillMarkdownParser } from "../../src/skills/SkillMarkdownParser";
import { SkillLoader } from "../../src/skills/SkillLoader";
import { SkillManager } from "../../src/skills/SkillManager";
import { SkillPromptBuilder } from "../../src/skills/SkillPromptBuilder";
import { SkillConfigFile } from "../../src/skills/SkillConfigFile";

const TEST_DIR = "/tmp/little_claw_e2e_skill_test";
const SKILLS_DIR = join(TEST_DIR, "skills");
const CONFIG_PATH = join(TEST_DIR, "config.json");

/**
 * 自定义 SkillLoader，指向测试目录而非默认的 ~/.little_claw/skills。
 */
class TestSkillLoader extends SkillLoader {
  private testDir: string;

  constructor(testDir: string) {
    super();
    this.testDir = testDir;
  }

  override async loadAll() {
    const parser = new SkillMarkdownParser();
    const glob = new Bun.Glob("*/SKILL.md");
    const results = [];

    for await (const match of glob.scan({
      cwd: this.testDir,
      absolute: true,
    })) {
      const parsed = await parser.parse(match);
      results.push({ parsed, source: match });
    }

    return results;
  }
}

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SKILLS_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Skill E2E: parse → load → inject", () => {
  test("hello-world skill is parsed correctly from SKILL.md", async () => {
    // 创建测试用 SKILL.md
    const skillDir = join(SKILLS_DIR, "hello-world");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: hello-world
description: Say hello in different languages
version: 1.0.0
---

# Hello World

## When to use
When the user asks to say hello or greet someone in a specific language.

## How to use
Run this command to get a greeting:
\`\`\`bash
echo "Hello / 你好 / こんにちは / 안녕하세요 / Bonjour"
\`\`\`

If the user specifies a language, respond with only that language's greeting.
`,
    );

    const parser = new SkillMarkdownParser();
    const parsed = await parser.parse(join(skillDir, "SKILL.md"));

    expect(parsed.name).toBe("hello-world");
    expect(parsed.description).toBe("Say hello in different languages");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.instructions).toContain("# Hello World");
    expect(parsed.instructions).toContain("こんにちは");
    expect(parsed.requires.env).toEqual([]);
    expect(parsed.requires.bins).toEqual([]);
  });

  test("SkillLoader finds the hello-world skill", async () => {
    const loader = new TestSkillLoader(SKILLS_DIR);
    const skills = await loader.loadAll();

    expect(skills.length).toBe(1);
    expect(skills[0]!.parsed.name).toBe("hello-world");
  });

  test("SkillManager loads hello-world as status=loaded (no deps)", async () => {
    // 创建 config（空 entries）
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ skills: { entries: {} } }),
    );

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    const loader = new TestSkillLoader(SKILLS_DIR);
    const manager = new SkillManager(loader, config);
    await manager.initializeAll();

    const all = manager.getAllSkills();
    expect(all.length).toBe(1);
    expect(all[0]!.status).toBe("loaded");
    expect(all[0]!.parsed.name).toBe("hello-world");

    const loaded = manager.getLoadedSkills();
    expect(loaded.length).toBe(1);

    const summary = manager.getSummary();
    expect(summary.total).toBe(1);
    expect(summary.loaded).toBe(1);
    expect(summary.unavailable).toBe(0);
    expect(summary.disabled).toBe(0);
  });

  test("SkillManager correctly disables skill via config", async () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        skills: {
          entries: {
            "hello-world": { enabled: false },
          },
        },
      }),
    );

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    const loader = new TestSkillLoader(SKILLS_DIR);
    const manager = new SkillManager(loader, config);
    await manager.initializeAll();

    const all = manager.getAllSkills();
    expect(all.length).toBe(1);
    expect(all[0]!.status).toBe("disabled");

    const loaded = manager.getLoadedSkills();
    expect(loaded.length).toBe(0);

    const summary = manager.getSummary();
    expect(summary.disabled).toBe(1);
  });

  test("SkillPromptBuilder generates XML with skill instructions", async () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ skills: { entries: {} } }),
    );

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    const loader = new TestSkillLoader(SKILLS_DIR);
    const manager = new SkillManager(loader, config);
    await manager.initializeAll();

    const builder = new SkillPromptBuilder();
    const prompt = builder.buildSkillPrompt(manager.getLoadedSkills());

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain('name="hello-world"');
    expect(prompt).toContain('description="Say hello in different languages"');
    expect(prompt).toContain("こんにちは");
    expect(prompt).toContain("</skill>");
    expect(prompt).toContain("</available_skills>");
  });

  test("full injection chain: skill instructions appear in effective system prompt", async () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ skills: { entries: {} } }),
    );

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    const loader = new TestSkillLoader(SKILLS_DIR);
    const manager = new SkillManager(loader, config);
    await manager.initializeAll();

    // 模拟 AgentLoop.getEffectiveSystemPrompt() 的逻辑
    const basePrompt = "You are a helpful AI assistant.";
    const loadedSkills = manager.getLoadedSkills();
    expect(loadedSkills.length).toBe(1);

    const builder = new SkillPromptBuilder();
    const skillPrompt = builder.buildSkillPrompt(
      loadedSkills,
      undefined,
      manager.getRecentlyUsed(),
    );

    const effectivePrompt = `${basePrompt}\n\n${skillPrompt}`;

    // 验证最终 prompt 包含 skill 指令
    expect(effectivePrompt).toContain("You are a helpful AI assistant.");
    expect(effectivePrompt).toContain("<available_skills>");
    expect(effectivePrompt).toContain("hello-world");
    expect(effectivePrompt).toContain("こんにちは");
    expect(effectivePrompt).toContain("echo");
  });

  test("SkillManager.reload() re-scans and picks up new skills", async () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ skills: { entries: {} } }),
    );

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    const loader = new TestSkillLoader(SKILLS_DIR);
    const manager = new SkillManager(loader, config);
    await manager.initializeAll();

    expect(manager.getAllSkills().length).toBe(1);

    // 添加第二个 skill
    const newSkillDir = join(SKILLS_DIR, "goodbye");
    mkdirSync(newSkillDir, { recursive: true });
    writeFileSync(
      join(newSkillDir, "SKILL.md"),
      `---
name: goodbye
description: Say goodbye in different languages
version: 0.1.0
---

# Goodbye

Say farewell!
`,
    );

    await manager.reload();

    expect(manager.getAllSkills().length).toBe(2);
    const names = manager.getAllSkills().map((s) => s.parsed.name).sort();
    expect(names).toEqual(["goodbye", "hello-world"]);
  });
});

describe("Skill E2E: {baseDir} replacement", () => {
  test("my-ip-checker SKILL.md with {baseDir} is parsed correctly", async () => {
    const skillDir = join(SKILLS_DIR, "my-ip-checker");
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, "check_ip.py"),
      `import urllib.request
import json

resp = urllib.request.urlopen("https://httpbin.org/ip")
data = json.loads(resp.read())
print(json.dumps(data, indent=2))
`,
    );

    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: my-ip-checker
description: Check the current public IP address
version: 1.0.0
metadata:
  openclaw:
    requires:
      bins:
        - python3
---

# IP Checker

## When to use
When the user asks about their IP address or network info.

## How to use
Run the script in this skill's directory:
\`\`\`bash
python3 {baseDir}/check_ip.py
\`\`\`

Parse the JSON output and present the IP address to the user.
`,
    );

    const parser = new SkillMarkdownParser();
    const parsed = await parser.parse(join(skillDir, "SKILL.md"));

    expect(parsed.name).toBe("my-ip-checker");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.requires.bins).toEqual(["python3"]);
    // 原始 instructions 保留 {baseDir} 占位符
    expect(parsed.instructions).toContain("{baseDir}/check_ip.py");
    expect(parsed.sourcePath).toBe(skillDir);
  });

  test("{baseDir} is replaced with sourcePath in prompt output", async () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ skills: { entries: {} } }),
    );

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    const loader = new TestSkillLoader(SKILLS_DIR);
    const manager = new SkillManager(loader, config);
    await manager.initializeAll();

    const ipSkill = manager.getSkill("my-ip-checker");
    expect(ipSkill).toBeDefined();
    expect(ipSkill!.status).toBe("loaded");

    const builder = new SkillPromptBuilder();
    const prompt = builder.buildSkillPrompt(manager.getLoadedSkills());

    // {baseDir} 应被替换为实际目录
    const expectedPath = join(SKILLS_DIR, "my-ip-checker");
    expect(prompt).toContain(`python3 ${expectedPath}/check_ip.py`);
    // 确认 {baseDir} 不再出现
    expect(prompt).not.toContain("{baseDir}");
  });

  test("multiple {baseDir} occurrences are all replaced", async () => {
    const builder = new SkillPromptBuilder();
    const fakeSkill = {
      name: "multi-ref",
      description: "test",
      version: "1.0.0",
      requires: { env: [], bins: [], anyBins: [], config: [] },
      instructions:
        "Run {baseDir}/a.sh then {baseDir}/b.sh and check {baseDir}/config.json",
      sourcePath: "/opt/skills/multi-ref",
    };

    const prompt = builder.buildSkillPrompt([fakeSkill]);

    expect(prompt).toContain("/opt/skills/multi-ref/a.sh");
    expect(prompt).toContain("/opt/skills/multi-ref/b.sh");
    expect(prompt).toContain("/opt/skills/multi-ref/config.json");
    expect(prompt).not.toContain("{baseDir}");
  });

  test("skill without {baseDir} is unaffected", async () => {
    const builder = new SkillPromptBuilder();
    const fakeSkill = {
      name: "no-basedir",
      description: "test",
      version: "1.0.0",
      requires: { env: [], bins: [], anyBins: [], config: [] },
      instructions: "Just run: echo hello",
      sourcePath: "/some/path",
    };

    const prompt = builder.buildSkillPrompt([fakeSkill]);

    expect(prompt).toContain("Just run: echo hello");
    expect(prompt).not.toContain("/some/path");
  });
});
