import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
} from "bun:test";
import { SkillMarkdownParser } from "../../src/skills/SkillMarkdownParser";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/little_claw_skill_parser_test";
const parser = new SkillMarkdownParser();

function writeSkill(dir: string, content: string): string {
  const skillDir = join(TEST_DIR, dir);
  mkdirSync(skillDir, { recursive: true });
  const filePath = join(skillDir, "SKILL.md");
  Bun.write(filePath, content);
  return filePath;
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("SkillMarkdownParser", () => {
  test("parses a complete SKILL.md with openclaw metadata", async () => {
    const filePath = writeSkill(
      "complete-skill",
      `---
name: my-tool
description: A useful tool for developers
version: 1.2.3
author: Alice
tags:
  - dev
  - productivity
metadata:
  openclaw:
    emoji: "🔧"
    primaryEnv: MY_API_KEY
    requires:
      env:
        - MY_API_KEY
        - MY_SECRET
      bins:
        - git
        - node
      anyBins:
        - docker
        - podman
      config:
        - ~/.my-tool.json
---
# My Tool Instructions

Use this tool to do great things.

## Usage

Run \`my-tool --help\` for details.
`,
    );

    const skill = await parser.parse(filePath);
    expect(skill.name).toBe("my-tool");
    expect(skill.description).toBe("A useful tool for developers");
    expect(skill.version).toBe("1.2.3");
    expect(skill.author).toBe("Alice");
    expect(skill.emoji).toBe("🔧");
    expect(skill.tags).toEqual(["dev", "productivity"]);
    expect(skill.primaryEnv).toBe("MY_API_KEY");
    expect(skill.requires.env).toEqual(["MY_API_KEY", "MY_SECRET"]);
    expect(skill.requires.bins).toEqual(["git", "node"]);
    expect(skill.requires.anyBins).toEqual(["docker", "podman"]);
    expect(skill.requires.config).toEqual(["~/.my-tool.json"]);
    expect(skill.instructions).toContain("# My Tool Instructions");
    expect(skill.instructions).toContain("Run `my-tool --help` for details.");
    expect(skill.sourcePath).toBe(join(TEST_DIR, "complete-skill"));
  });

  test("supports clawdbot metadata alias", async () => {
    const filePath = writeSkill(
      "clawdbot-skill",
      `---
name: bot-skill
description: A bot skill
metadata:
  clawdbot:
    emoji: "🤖"
    primaryEnv: BOT_TOKEN
    requires:
      env:
        - BOT_TOKEN
---
Bot instructions here.
`,
    );

    const skill = await parser.parse(filePath);
    expect(skill.emoji).toBe("🤖");
    expect(skill.primaryEnv).toBe("BOT_TOKEN");
    expect(skill.requires.env).toEqual(["BOT_TOKEN"]);
  });

  test("supports clawdis metadata alias", async () => {
    const filePath = writeSkill(
      "clawdis-skill",
      `---
name: dis-skill
description: A dis skill
metadata:
  clawdis:
    emoji: "⚡"
    requires:
      bins:
        - curl
---
Dis instructions.
`,
    );

    const skill = await parser.parse(filePath);
    expect(skill.emoji).toBe("⚡");
    expect(skill.requires.bins).toEqual(["curl"]);
  });

  test("defaults name to directory name when missing", async () => {
    const filePath = writeSkill(
      "my-default-name",
      `---
description: Has no name field
---
Some instructions.
`,
    );

    const skill = await parser.parse(filePath);
    expect(skill.name).toBe("my-default-name");
  });

  test("defaults version to 0.0.0 when missing", async () => {
    const filePath = writeSkill(
      "no-version",
      `---
name: no-version-skill
description: Has no version
---
Instructions.
`,
    );

    const skill = await parser.parse(filePath);
    expect(skill.version).toBe("0.0.0");
  });

  test("defaults requires fields to empty arrays", async () => {
    const filePath = writeSkill(
      "no-requires",
      `---
name: simple
description: A simple skill
---
Just instructions.
`,
    );

    const skill = await parser.parse(filePath);
    expect(skill.requires.env).toEqual([]);
    expect(skill.requires.bins).toEqual([]);
    expect(skill.requires.anyBins).toEqual([]);
    expect(skill.requires.config).toEqual([]);
  });

  test("emoji falls back to top-level when not in metadata", async () => {
    const filePath = writeSkill(
      "toplevel-emoji",
      `---
name: emoji-skill
description: Has top-level emoji
emoji: "🎯"
---
Instructions.
`,
    );

    const skill = await parser.parse(filePath);
    expect(skill.emoji).toBe("🎯");
  });

  test("metadata emoji takes priority over top-level", async () => {
    const filePath = writeSkill(
      "emoji-priority",
      `---
name: emoji-priority
description: Both emojis
emoji: "🎯"
metadata:
  openclaw:
    emoji: "🚀"
---
Instructions.
`,
    );

    const skill = await parser.parse(filePath);
    expect(skill.emoji).toBe("🚀");
  });

  test("supports primary_env snake_case alias", async () => {
    const filePath = writeSkill(
      "snake-case-env",
      `---
name: snake-env
description: Snake case primary env
metadata:
  openclaw:
    primary_env: SNAKE_KEY
---
Instructions.
`,
    );

    const skill = await parser.parse(filePath);
    expect(skill.primaryEnv).toBe("SNAKE_KEY");
  });

  test("supports any_bins snake_case alias in requires", async () => {
    const filePath = writeSkill(
      "snake-any-bins",
      `---
name: snake-bins
description: Snake case any bins
metadata:
  openclaw:
    requires:
      any_bins:
        - docker
        - podman
---
Instructions.
`,
    );

    const skill = await parser.parse(filePath);
    expect(skill.requires.anyBins).toEqual(["docker", "podman"]);
  });

  test("throws on missing file", async () => {
    await expect(
      parser.parse("/tmp/nonexistent/SKILL.md"),
    ).rejects.toThrow("SKILL.md not found");
  });

  test("throws on missing frontmatter", async () => {
    const filePath = writeSkill(
      "no-frontmatter",
      `# Just Markdown

No frontmatter here.
`,
    );

    await expect(parser.parse(filePath)).rejects.toThrow(
      "missing YAML frontmatter",
    );
  });

  test("throws on invalid YAML", async () => {
    const filePath = writeSkill(
      "bad-yaml",
      `---
name: [invalid yaml
  this: is: broken: {
---
Body.
`,
    );

    await expect(parser.parse(filePath)).rejects.toThrow("YAML parse error");
  });

  test("throws on missing description", async () => {
    const filePath = writeSkill(
      "no-description",
      `---
name: no-desc
---
Instructions.
`,
    );

    await expect(parser.parse(filePath)).rejects.toThrow(
      "missing required field 'description'",
    );
  });

  test("preserves markdown body exactly", async () => {
    const body = `# Title

Some **bold** and _italic_ text.

\`\`\`ts
const x = 1;
\`\`\`

- List item 1
- List item 2`;

    const filePath = writeSkill(
      "preserve-body",
      `---
name: body-test
description: Body preservation test
---
${body}`,
    );

    const skill = await parser.parse(filePath);
    expect(skill.instructions).toBe(body);
  });

  test("error messages include file path", async () => {
    const filePath = "/tmp/nonexistent-path/SKILL.md";
    try {
      await parser.parse(filePath);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect((err as Error).message).toContain(filePath);
    }
  });
});
