import { describe, expect, test } from "bun:test";
import { SkillPromptBuilder } from "../../src/skills/SkillPromptBuilder";
import type { ParsedSkill } from "../../src/skills/types";

function skill(name: string): ParsedSkill {
  return {
    name,
    description: `${name} description`,
    version: "1.0.0",
    requires: { env: [], bins: [], anyBins: [], config: [] },
    instructions: `# ${name}\n\nFull instructions for ${name}.`,
    sourcePath: `/tmp/${name}`,
  };
}

describe("SkillPromptBuilder", () => {
  test("includes only the requested number of full skill bodies", () => {
    const prompt = new SkillPromptBuilder().buildSkillPrompt(
      [skill("one"), skill("two"), skill("three")],
      20_000,
      { fullLimit: 1, summaryLimit: 1 },
    );

    expect(prompt).toContain("Full instructions for one.");
    expect(prompt).toContain('<skill name="two" description="two description" />');
    expect(prompt).not.toContain("Full instructions for two.");
    expect(prompt).not.toContain("three description");
  });

  test("keeps all configured skills full when full limit is infinite", () => {
    const prompt = new SkillPromptBuilder().buildSkillPrompt(
      [skill("one"), skill("two")],
      20_000,
      { fullLimit: Number.POSITIVE_INFINITY, summaryLimit: 0 },
    );

    expect(prompt).toContain("Full instructions for one.");
    expect(prompt).toContain("Full instructions for two.");
  });
});
