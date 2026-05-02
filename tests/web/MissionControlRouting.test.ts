import { describe, expect, test } from "bun:test";
import { shouldUseTeamRouter } from "../../web/src/components/mission-control/channel-routing.ts";

describe("Mission Control channel routing", () => {
  test("keeps agent mentions inside the selected project channel", () => {
    expect(shouldUseTeamRouter("@coder 写一个 hello 脚本", { type: "project" })).toBe(false);
  });

  test("keeps project-looking text inside the selected project channel", () => {
    expect(shouldUseTeamRouter("#other 临时备注", { type: "project" })).toBe(false);
  });

  test("routes mentions from non-project views through TeamRouter", () => {
    expect(shouldUseTeamRouter("@coder 写一个 hello 脚本", { type: "all" })).toBe(true);
    expect(shouldUseTeamRouter("#hello 写一个 hello 脚本", { type: "all" })).toBe(true);
    expect(shouldUseTeamRouter("@coder 写一个 hello 脚本", { type: "agent_dm" })).toBe(true);
  });

  test("keeps task control commands global", () => {
    expect(shouldUseTeamRouter("/task approve task-1", { type: "project" })).toBe(true);
  });
});
