import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { SkillConfigFile } from "../../src/skills/SkillConfigFile";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/little_claw_config_test";
const CONFIG_PATH = join(TEST_DIR, "config.json");

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("SkillConfigFile", () => {
  test("creates default config when file does not exist", async () => {
    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    const raw = config.getRawConfig();
    expect(raw.skills).toBeDefined();
    expect(raw.skills.entries).toEqual({});
    expect(raw.skills.tokenBudget).toBe(20000);

    // File should be created on disk
    const file = Bun.file(CONFIG_PATH);
    expect(await file.exists()).toBe(true);
    const content = JSON.parse(await file.text());
    expect(content.skills.entries).toEqual({});
  });

  test("loads existing config", async () => {
    const configData = {
      skills: {
        tokenBudget: 8000,
        entries: {
          "my-skill": {
            enabled: true,
            env: { API_KEY: "test-key" },
          },
          "disabled-skill": {
            enabled: false,
          },
        },
      },
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(configData));

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    expect(config.getTokenBudget()).toBe(8000);
    expect(config.isDisabled("my-skill")).toBe(false);
    expect(config.isDisabled("disabled-skill")).toBe(true);
    expect(config.isDisabled("unknown-skill")).toBe(false);
  });

  test("getEnvOverrides returns configured env vars", async () => {
    const configData = {
      skills: {
        entries: {
          "my-skill": {
            enabled: true,
            env: { API_KEY: "my-key", SECRET: "my-secret" },
          },
        },
      },
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(configData));

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    const overrides = config.getEnvOverrides("my-skill");
    expect(overrides).toEqual({ API_KEY: "my-key", SECRET: "my-secret" });
  });

  test("getEnvOverrides returns empty for unknown skill", async () => {
    const configData = { skills: { entries: {} } };
    writeFileSync(CONFIG_PATH, JSON.stringify(configData));

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    expect(config.getEnvOverrides("nonexistent")).toEqual({});
  });

  test("handles malformed JSON gracefully", async () => {
    writeFileSync(CONFIG_PATH, "{ not valid json }}}");

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    // Should fall back to defaults
    expect(config.getTokenBudget()).toBe(20000);
    expect(config.isDisabled("anything")).toBe(false);
  });

  test("handles partial config", async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ skills: {} }));

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    expect(config.getTokenBudget()).toBe(20000);
    expect(config.getRawConfig().skills.entries).toEqual({});
  });

  test("reload re-reads the file", async () => {
    // Start with empty config
    writeFileSync(CONFIG_PATH, JSON.stringify({ skills: { entries: {} } }));
    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();
    expect(config.isDisabled("my-skill")).toBe(false);

    // Update the file
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        skills: {
          entries: {
            "my-skill": { enabled: false },
          },
        },
      }),
    );

    await config.reload();
    expect(config.isDisabled("my-skill")).toBe(true);
  });

  test("isDisabled returns false when enabled is true", async () => {
    const configData = {
      skills: {
        entries: {
          "active-skill": { enabled: true },
        },
      },
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(configData));

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    expect(config.isDisabled("active-skill")).toBe(false);
  });

  test("isDisabled returns false when entry exists without enabled field", async () => {
    const configData = {
      skills: {
        entries: {
          "my-skill": { env: { KEY: "val" } },
        },
      },
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(configData));

    const config = new SkillConfigFile(CONFIG_PATH);
    await config.load();

    expect(config.isDisabled("my-skill")).toBe(false);
  });

  test("getConfigPath returns the path", () => {
    const config = new SkillConfigFile(CONFIG_PATH);
    expect(config.getConfigPath()).toBe(CONFIG_PATH);
  });
});
