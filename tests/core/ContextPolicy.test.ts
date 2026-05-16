import { describe, expect, test } from "bun:test";
import { buildContextPolicy } from "../../src/core/ContextPolicy";

describe("ContextPolicy", () => {
  test("keeps roleplay knowledge requests lightweight", () => {
    const policy = buildContextPolicy({
      userMessage: "假如你是马斯克，你解释一下Optimus机器人的训练原理",
      runMode: "chat",
      contextMode: "auto",
      hasProjectContext: false,
      hasConfiguredSkills: false,
    });

    expect(policy.loadContextMap).toBe(false);
    expect(policy.retrieveContextOverviews).toBe(false);
    expect(policy.loadInbox).toBe(false);
    expect(policy.memoryRecallTopK).toBe(1);
    expect(policy.skillFullLimit).toBe(1);
  });

  test("loads personal context when context intent is explicit", () => {
    const policy = buildContextPolicy({
      userMessage: "帮我看一下之前项目里的上下文",
      runMode: "chat",
      contextMode: "auto",
      hasProjectContext: false,
      hasConfiguredSkills: false,
    });

    expect(policy.loadContextMap).toBe(true);
    expect(policy.retrieveContextOverviews).toBe(true);
    expect(policy.loadInbox).toBe(true);
    expect(policy.memoryRecallTopK).toBe(5);
  });

  test("team worker uses project context instead of global context map", () => {
    const policy = buildContextPolicy({
      userMessage: "Handle the task",
      runMode: "team_worker",
      contextMode: "project",
      hasProjectContext: true,
      hasConfiguredSkills: false,
    });

    expect(policy.loadProjectOverview).toBe(true);
    expect(policy.loadContextMap).toBe(false);
    expect(policy.retrieveContextOverviews).toBe(false);
  });

  test("projectless team worker can use broad context", () => {
    const policy = buildContextPolicy({
      userMessage: "Create one isolated morning spark for the user.",
      runMode: "team_worker",
      contextMode: "always",
      hasProjectContext: false,
      hasConfiguredSkills: false,
    });

    expect(policy.loadIdentity).toBe(true);
    expect(policy.loadInbox).toBe(true);
    expect(policy.loadContextMap).toBe(true);
    expect(policy.retrieveContextOverviews).toBe(true);
    expect(policy.loadProjectOverview).toBe(false);
    expect(policy.memoryRecallTopK).toBe(5);
    expect(policy.contextOverviewTopK).toBe(3);
  });
});
