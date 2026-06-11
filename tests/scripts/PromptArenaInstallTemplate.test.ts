import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Prompt Arena install template", () => {
  test("preflights active arena tasks without passing active_conflict_tags to create_task_dag", () => {
    const script = readFileSync(
      join(import.meta.dir, "../../scripts/install-prompt-arena-demo.ts"),
      "utf8",
    );

    expect(script).toContain('active_only true, and mode "summary"');
    expect(script).not.toContain('"active_conflict_tags": ["arena"]');
  });
});
