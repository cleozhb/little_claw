import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ContextHub } from "../../src/memory/ContextHub";

const TMP = "/tmp/little_claw_ctxhub_test";

let hub: ContextHub;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  hub = new ContextHub(TMP);
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("ContextHub.initialize", () => {
  test("creates the standard top-level directories", async () => {
    await hub.initialize();
    for (const dir of ["0-identity", "1-inbox", "2-areas", "3-projects", "4-knowledge", "5-archive"]) {
      expect(existsSync(join(TMP, "context-hub", dir))).toBe(true);
    }
  });

  test("creates default abstracts and overviews", async () => {
    await hub.initialize();
    expect(existsSync(join(TMP, "context-hub", ".abstract.md"))).toBe(true);
    expect(existsSync(join(TMP, "context-hub", "0-identity", ".abstract.md"))).toBe(true);
    expect(existsSync(join(TMP, "context-hub", "0-identity", "profile.md"))).toBe(true);
    expect(existsSync(join(TMP, "context-hub", "1-inbox", "inbox.md"))).toBe(true);
  });

  test("preserves user edits across re-initialize", async () => {
    await hub.initialize();
    const profilePath = join(TMP, "context-hub", "0-identity", "profile.md");
    writeFileSync(profilePath, "# My Profile\n\nimportant stuff\n");

    await hub.initialize();
    expect(readFileSync(profilePath, "utf8")).toContain("important stuff");
  });

  test("migrates legacy USER.md and memory/MEMORY.md on first run", async () => {
    writeFileSync(join(TMP, "USER.md"), "# Legacy User\nLikes pizza.\n");
    mkdirSync(join(TMP, "memory"), { recursive: true });
    writeFileSync(join(TMP, "memory", "MEMORY.md"), "## Past\nold notes\n");

    const r = await hub.initialize();
    expect(r.migrated).toBe(true);
    expect(existsSync(join(TMP, "USER.md.bak"))).toBe(true);
    expect(existsSync(join(TMP, "memory", "MEMORY.md.bak"))).toBe(true);

    const profile = readFileSync(join(TMP, "context-hub", "0-identity", "profile.md"), "utf8");
    expect(profile).toContain("Likes pizza");
    const archive = readFileSync(join(TMP, "context-hub", "4-knowledge", "memory-archive.md"), "utf8");
    expect(archive).toContain("old notes");
  });

  test("second initialize after migration does not re-migrate", async () => {
    writeFileSync(join(TMP, "USER.md"), "# x\n");
    const first = await hub.initialize();
    expect(first.migrated).toBe(true);
    const second = await hub.initialize();
    expect(second.migrated).toBe(false);
  });
});

describe("ContextHub path safety", () => {
  beforeEach(async () => {
    await hub.initialize();
  });

  test("rejects path traversal on read", async () => {
    expect(() => hub.readFile("../../etc/passwd")).toThrow(/traversal|within/);
  });

  test("rejects path traversal on write", async () => {
    expect(() => hub.writeFile("../escape.txt", "x", "overwrite")).toThrow(/traversal|within/);
    expect(existsSync(join(TMP, "escape.txt"))).toBe(false);
  });

  test("accepts paths with and without context-hub/ prefix", async () => {
    await hub.writeFile("4-knowledge/note.md", "hello", "overwrite");
    const a = await hub.readFile("4-knowledge/note.md");
    const b = await hub.readFile("context-hub/4-knowledge/note.md");
    expect(a).toBe("hello");
    expect(b).toBe("hello");
  });
});

describe("ContextHub.scanAbstracts", () => {
  test("returns relative paths and abstract content for each directory", async () => {
    await hub.initialize();
    const map = await hub.scanAbstracts();
    const lines = map.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(map).toContain("context-hub/0-identity/");
    expect(map).toContain("context-hub/1-inbox/");
    expect(map).toContain("context-hub/5-archive/");
  });

  test("includes nested directories with abstracts", async () => {
    await hub.initialize();
    await hub.writeFile(
      "3-projects/sample/.abstract.md",
      "Sample test project",
      "overwrite",
    );
    const map = await hub.scanAbstracts();
    expect(map).toContain("3-projects/sample/");
    expect(map).toContain("Sample test project");
  });
});

describe("ContextHub.writeFile append", () => {
  test("appends to existing file with newline separator", async () => {
    await hub.initialize();
    await hub.writeFile("4-knowledge/log.md", "line1", "overwrite");
    await hub.writeFile("4-knowledge/log.md", "line2", "append");
    const content = await hub.readFile("4-knowledge/log.md");
    expect(content).toBe("line1\nline2");
  });

  test("creates the file when appending to a missing path", async () => {
    await hub.initialize();
    await hub.writeFile("4-knowledge/new.md", "first", "append");
    expect(await hub.readFile("4-knowledge/new.md")).toBe("first");
  });
});

describe("ContextHub.listFiles / listDirectories", () => {
  test("lists files excluding meta files", async () => {
    await hub.initialize();
    await hub.writeFile("4-knowledge/a.md", "x", "overwrite");
    await hub.writeFile("4-knowledge/b.md", "y", "overwrite");
    const files = await hub.listFiles("4-knowledge");
    expect(files).toContain("a.md");
    expect(files).toContain("b.md");
    expect(files).not.toContain(".abstract.md");
    expect(files).not.toContain(".overview.md");
  });

  test("lists directories under context-hub recursively", async () => {
    await hub.initialize();
    await hub.writeFile("3-projects/sample/.abstract.md", "x", "overwrite");
    const dirs = await hub.listDirectories();
    expect(dirs).toContain("context-hub/3-projects");
    expect(dirs).toContain("context-hub/3-projects/sample");
  });
});
