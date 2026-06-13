import { expect, test } from "bun:test";
import { projectWorkspaceRoot, scopeProjectWritePath } from "../../src/core/ProjectWorkspace.ts";

test("project workspace root resolves from context-hub project paths", () => {
  expect(
    projectWorkspaceRoot("/tmp/little_claw_workspace", "context-hub/3-projects/technology-blog"),
  ).toBe("/tmp/little_claw_workspace/context-hub/3-projects/technology-blog");
});

test("project write paths are scoped into the active project workspace", () => {
  const project = "context-hub/3-projects/technology-blog";

  expect(scopeProjectWritePath("translation.md", project)).toEqual({
    ok: true,
    path: "context-hub/3-projects/technology-blog/translation.md",
  });
  expect(scopeProjectWritePath("docs/translation.md", project)).toEqual({
    ok: true,
    path: "context-hub/3-projects/technology-blog/docs/translation.md",
  });
  expect(scopeProjectWritePath("context-hub/3-projects/technology-blog/status.md", project)).toEqual({
    ok: true,
    path: "context-hub/3-projects/technology-blog/status.md",
  });
});

test("project write paths reject explicit non-project destinations", () => {
  const project = "context-hub/3-projects/technology-blog";

  expect(scopeProjectWritePath("context-hub/3-projects/other-project/status.md", project)).toEqual({
    ok: false,
    error:
      'Project task write denied: write_file path "context-hub/3-projects/other-project/status.md" is outside context-hub/3-projects/technology-blog/.',
  });
  expect(scopeProjectWritePath("../status.md", project)).toEqual({
    ok: false,
    error:
      'Project task write denied: write_file path "../status.md" must stay under context-hub/3-projects/technology-blog/.',
  });
});
