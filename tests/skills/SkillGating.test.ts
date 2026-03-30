import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { checkGating } from "../../src/skills/SkillGating";
import type { ParsedSkill, SkillRequires } from "../../src/skills/types";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/little_claw_gating_test";

function makeSkill(requires: Partial<SkillRequires> = {}): ParsedSkill {
  return {
    name: "test-skill",
    description: "A test skill",
    version: "1.0.0",
    requires: {
      env: [],
      bins: [],
      anyBins: [],
      config: [],
      ...requires,
    },
    instructions: "Test instructions",
    sourcePath: "/tmp/test-skill",
  };
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("SkillGating", () => {
  describe("env checks", () => {
    test("passes when env var exists in process.env", async () => {
      // PATH is always set
      const skill = makeSkill({ env: ["PATH"] });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(true);
      expect(result.missingEnv).toEqual([]);
    });

    test("fails when env var is missing", async () => {
      const skill = makeSkill({
        env: ["__LITTLE_CLAW_TEST_NONEXISTENT_VAR__"],
      });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(false);
      expect(result.missingEnv).toEqual([
        "__LITTLE_CLAW_TEST_NONEXISTENT_VAR__",
      ]);
    });

    test("passes when env var provided via overrides", async () => {
      const skill = makeSkill({
        env: ["__LITTLE_CLAW_TEST_NONEXISTENT_VAR__"],
      });
      const result = await checkGating(skill, {
        __LITTLE_CLAW_TEST_NONEXISTENT_VAR__: "some-value",
      });
      expect(result.eligible).toBe(true);
      expect(result.missingEnv).toEqual([]);
    });

    test("reports multiple missing env vars", async () => {
      const skill = makeSkill({
        env: [
          "PATH",
          "__MISSING_A__",
          "__MISSING_B__",
        ],
      });
      const result = await checkGating(skill);
      expect(result.missingEnv).toEqual(["__MISSING_A__", "__MISSING_B__"]);
    });

    test("override takes priority even if process.env also has it", async () => {
      const skill = makeSkill({ env: ["PATH"] });
      const result = await checkGating(skill, { PATH: "overridden" });
      expect(result.eligible).toBe(true);
      expect(result.missingEnv).toEqual([]);
    });
  });

  describe("bins checks", () => {
    test("passes when binary exists", async () => {
      // `ls` exists on all unix systems
      const skill = makeSkill({ bins: ["ls"] });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(true);
      expect(result.missingBins).toEqual([]);
    });

    test("fails when binary does not exist", async () => {
      const skill = makeSkill({
        bins: ["__nonexistent_binary_xyz__"],
      });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(false);
      expect(result.missingBins).toContain("__nonexistent_binary_xyz__");
    });

    test("fails if any required bin is missing", async () => {
      const skill = makeSkill({
        bins: ["ls", "__nonexistent_binary_xyz__"],
      });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(false);
      expect(result.missingBins).toEqual(["__nonexistent_binary_xyz__"]);
    });
  });

  describe("anyBins checks", () => {
    test("passes when at least one bin exists", async () => {
      const skill = makeSkill({
        anyBins: ["__nonexistent_a__", "ls", "__nonexistent_b__"],
      });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(true);
      expect(result.missingBins).toEqual([]);
    });

    test("fails when none of the anyBins exist", async () => {
      const skill = makeSkill({
        anyBins: ["__nonexistent_a__", "__nonexistent_b__"],
      });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(false);
      expect(result.missingBins).toEqual([
        "__nonexistent_a__",
        "__nonexistent_b__",
      ]);
    });

    test("empty anyBins passes", async () => {
      const skill = makeSkill({ anyBins: [] });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(true);
    });
  });

  describe("config checks", () => {
    test("passes when config file exists", async () => {
      const configPath = join(TEST_DIR, "test.config.json");
      writeFileSync(configPath, "{}");

      const skill = makeSkill({ config: [configPath] });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(true);
      expect(result.missingConfig).toEqual([]);
    });

    test("fails when config file does not exist", async () => {
      const skill = makeSkill({
        config: [join(TEST_DIR, "nonexistent.json")],
      });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(false);
      expect(result.missingConfig).toEqual([
        join(TEST_DIR, "nonexistent.json"),
      ]);
    });

    test("supports ~ expansion for home directory", async () => {
      // ~/.profile or ~/.bashrc typically exists on macOS/Linux
      // Use a file we know doesn't exist to test ~ expansion works
      const skill = makeSkill({
        config: ["~/__nonexistent_config_file__"],
      });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(false);
      expect(result.missingConfig).toEqual([
        "~/__nonexistent_config_file__",
      ]);
    });
  });

  describe("combined checks", () => {
    test("eligible when all requirements met", async () => {
      const configPath = join(TEST_DIR, "combined.json");
      writeFileSync(configPath, "{}");

      const skill = makeSkill({
        env: ["PATH"],
        bins: ["ls"],
        anyBins: ["ls", "__nonexistent__"],
        config: [configPath],
      });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(true);
      expect(result.missingEnv).toEqual([]);
      expect(result.missingBins).toEqual([]);
      expect(result.missingConfig).toEqual([]);
    });

    test("ineligible with multiple failure types", async () => {
      const skill = makeSkill({
        env: ["__MISSING_ENV__"],
        bins: ["__missing_bin__"],
        config: ["/tmp/__nonexistent__.cfg"],
      });
      const result = await checkGating(skill);
      expect(result.eligible).toBe(false);
      expect(result.missingEnv).toEqual(["__MISSING_ENV__"]);
      expect(result.missingBins).toContain("__missing_bin__");
      expect(result.missingConfig).toEqual(["/tmp/__nonexistent__.cfg"]);
    });

    test("skill with no requirements is eligible", async () => {
      const skill = makeSkill();
      const result = await checkGating(skill);
      expect(result.eligible).toBe(true);
      expect(result.missingEnv).toEqual([]);
      expect(result.missingBins).toEqual([]);
      expect(result.missingConfig).toEqual([]);
    });
  });
});
