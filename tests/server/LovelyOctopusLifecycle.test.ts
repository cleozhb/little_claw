import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/db/Database.ts";
import type { LLMProvider } from "../../src/llm/types.ts";
import {
  createLovelyOctopusRuntime,
  formatLovelyOctopusStatus,
  type LovelyOctopusRuntime,
} from "../../src/server.ts";
import { AgentRegistry } from "../../src/team/AgentRegistry.ts";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";

const TEST_DB = "/tmp/little_claw_server_lifecycle_test.db";

let db: Database;
let agentDir: string;
let runtime: LovelyOctopusRuntime | null;

const llmProvider: LLMProvider = {
  async *chat() {},
  getModel() {
    return "lifecycle-test-model";
  },
  setModel() {},
};

beforeEach(() => {
  cleanupDb();
  db = new Database(TEST_DB);
  agentDir = mkdtempAgentDir();
  runtime = null;
});

afterEach(async () => {
  await runtime?.stop();
  db.close();
  rmSync(agentDir, { recursive: true, force: true });
  cleanupDb();
});

describe("Lovely Octopus server lifecycle", () => {
  test("creates default agents, starts loops, reports status, and stops cleanly", async () => {
    runtime = createLovelyOctopusRuntime({
      db,
      llmProvider,
      toolRegistry: new ToolRegistry(),
      agentDir,
      workerPollIntervalMs: 5,
      coordinatorPollIntervalMs: 5,
    });

    expect(runtime.registeredAgents.map((agent) => agent.config.name).sort()).toEqual([
      "coder",
      "coordinator",
    ]);
    expect(runtime.agentWorkers).toHaveLength(2);

    runtime.start();
    await Bun.sleep(10);
    await runtime.stop();

    expect(runtime.agentWorkers.every((worker) => worker.state === "stopped")).toBe(true);
    expect(runtime.coordinatorLoop.state).toBe("stopped");

    const status = runtime.getStatus();
    expect(status.activeAgents).toBe(2);
    expect(status.registeredAgents).toBe(2);
    expect(status.projectChannels).toBe(0);
    expect(status.tasks.pending).toBe(0);
    expect(status.tasks.running).toBe(0);
    expect(status.tasks.awaitingApproval).toBe(0);
    expect(formatLovelyOctopusStatus(status)).toContain("Lovely Octopus: 2/2 active agents");
  });

  test("isolates malformed agent configs while starting healthy agents", async () => {
    const registry = new AgentRegistry(agentDir);
    registry.createFromTemplate("coder");

    const badDir = join(agentDir, "broken");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "agent.yaml"),
      "name: broken\nrole: Broken test agent\nstatus: active\n",
      "utf8",
    );

    runtime = createLovelyOctopusRuntime({
      db,
      llmProvider,
      toolRegistry: new ToolRegistry(),
      agentDir,
      workerPollIntervalMs: 5,
      coordinatorPollIntervalMs: 5,
    });

    expect(runtime.agentRegistry.getLoadErrors()).toHaveLength(1);
    expect(runtime.registeredAgents.map((agent) => agent.config.name)).toEqual(["coder"]);
    expect(runtime.agentWorkers).toHaveLength(1);

    runtime.start();
    await Bun.sleep(10);
    await runtime.stop();

    expect(runtime.agentWorkers[0]?.state).toBe("stopped");
  });
});

function mkdtempAgentDir(): string {
  return join(tmpdir(), `little-claw-server-lifecycle-agents-${crypto.randomUUID()}`);
}

function cleanupDb(): void {
  for (const path of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
