import { describe, expect, test } from "bun:test";
import {
  messageMatchesChannelSelection,
  shouldUseTeamRouter,
} from "../../web/src/components/mission-control/channel-routing.ts";

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

  test("shows project-scoped agent DMs in their project channel", () => {
    expect(
      messageMatchesChannelSelection(
        {
          channelType: "agent_dm",
          channelId: "coder",
          project: "hello",
        },
        { type: "project", id: "channel-id", project: "hello" },
      ),
    ).toBe(true);
  });

  test("does not leak unrelated agent DMs into a project channel", () => {
    expect(
      messageMatchesChannelSelection(
        {
          channelType: "agent_dm",
          channelId: "coder",
          project: "other",
        },
        { type: "project", id: "channel-id", project: "hello" },
      ),
    ).toBe(false);
  });
});
