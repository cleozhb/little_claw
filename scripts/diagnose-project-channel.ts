import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { Database } from "../src/db/Database.ts";
import { ProjectChannelStore, type ProjectChannel } from "../src/team/ProjectChannelStore.ts";
import { TaskQueue, type Task } from "../src/team/TaskQueue.ts";
import { TeamMessageStore, type TeamMessage } from "../src/team/TeamMessageStore.ts";

interface Args {
  dbPath: string;
  contextBase: string;
  project?: string;
  limit: number;
}

const args = parseArgs(Bun.argv.slice(2));

if (!existsSync(args.dbPath)) {
  console.error(`DB not found: ${args.dbPath}`);
  process.exit(1);
}

const db = new Database(args.dbPath);
try {
  const messages = new TeamMessageStore(db);
  const channels = new ProjectChannelStore(db, messages);
  const tasks = new TaskQueue(db);
  const channel = resolveProject(channels.listChannels({ limit: 500 }), args.project);

  if (!channel) {
    console.error(`Project channel not found: ${args.project ?? "(latest project)"}`);
    printKnownProjects(channels.listChannels({ limit: 50 }));
    process.exit(1);
  }

  const projectTasks = tasks.listTasks({ project: channel.slug, limit: 500 });
  const visibleProjectMessages = channels.listMessages(channel.slug, args.limit);
  const allProjectMessages = messages
    .listMessages({ channelType: "project", limit: 5000 })
    .filter((message) => message.project === channel.slug || message.channelId === channel.slug);
  const orphanProjectMessages = allProjectMessages.filter((message) => message.channelId !== channel.id);
  const coordinatorMessages = messages
    .listMessages({ channelType: "coordinator", channelId: "default", limit: 1000 })
    .filter((message) => isAfterProjectCreated(message, channel) || projectTasks.some((task) => task.id === message.taskId));
  const coderDms = messages
    .listMessages({ channelType: "agent_dm", limit: 1000 })
    .filter((message) =>
      (message.channelId === "coder" || message.senderId === "coder") &&
      isAfterProjectCreated(message, channel)
    );

  const projectDir = contextDirFor(channel, args.contextBase);
  const files = await listProjectFiles(projectDir);
  const statusPath = join(projectDir, "status.md");
  const statusContent = existsSync(statusPath) ? await readFile(statusPath, "utf8") : "";

  printHeader(channel, args, projectDir);
  printTasks(projectTasks, tasks, channel);
  printMessages("Project messages visible through ProjectChannelStore", visibleProjectMessages);
  printMessages("Project messages with matching project but hidden from channel view", orphanProjectMessages);
  printMessages("Coordinator default-channel messages after project creation", coordinatorMessages);
  printMessages("Coder DM messages after project creation", coderDms);
  printFiles(projectDir, files, statusContent, projectTasks);
  printDiagnosis({
    channel,
    projectTasks,
    visibleProjectMessages,
    orphanProjectMessages,
    coordinatorMessages,
    coderDms,
    files,
    statusContent,
  });
} finally {
  db.close();
}

function parseArgs(argv: string[]): Args {
  const defaults: Args = {
    dbPath: join(import.meta.dir, "..", "data", "little_claw.db"),
    contextBase: join(homedir(), ".little_claw"),
    limit: 100,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--project" || arg === "-p") && next) {
      defaults.project = next;
      i += 1;
    } else if (arg === "--db" && next) {
      defaults.dbPath = next;
      i += 1;
    } else if (arg === "--context-base" && next) {
      defaults.contextBase = next;
      i += 1;
    } else if (arg === "--limit" && next) {
      defaults.limit = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  bun scripts/diagnose-project-channel.ts --project <slug-or-title>

Options:
  --project, -p     Project slug, id, or title substring. Defaults to latest project.
  --db              SQLite DB path. Defaults to ./data/little_claw.db.
  --context-base    Base memory dir. Defaults to ~/.little_claw.
  --limit           Message limit per section. Defaults to 100.`);
      process.exit(0);
    }
  }

  if (!Number.isFinite(defaults.limit) || defaults.limit <= 0) {
    defaults.limit = 100;
  }
  return defaults;
}

function resolveProject(channels: ProjectChannel[], query: string | undefined): ProjectChannel | null {
  if (channels.length === 0) return null;
  if (!query?.trim()) return [...channels].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;

  const clean = query.trim().toLowerCase();
  return (
    channels.find((channel) => channel.slug.toLowerCase() === clean || channel.id === query) ??
    channels.find((channel) => channel.title.toLowerCase() === clean) ??
    channels.find((channel) =>
      channel.slug.toLowerCase().includes(clean) ||
      channel.title.toLowerCase().includes(clean) ||
      channel.description?.toLowerCase().includes(clean)
    ) ??
    null
  );
}

function printKnownProjects(channels: ProjectChannel[]): void {
  console.log("\nKnown projects:");
  for (const channel of channels) {
    console.log(`- ${channel.slug} (${channel.title}) id=${channel.id}`);
  }
}

function contextDirFor(channel: ProjectChannel, contextBase: string): string {
  const contextPath = channel.contextPath ?? `context-hub/3-projects/${channel.slug}`;
  const cleaned = contextPath.startsWith("context-hub/")
    ? contextPath.slice("context-hub/".length)
    : contextPath;
  return join(contextBase, "context-hub", cleaned);
}

function printHeader(channel: ProjectChannel, args: Args, projectDir: string): void {
  console.log("# Lovely Octopus project diagnostic\n");
  console.log(`db: ${args.dbPath}`);
  console.log(`context_base: ${args.contextBase}`);
  console.log(`project: ${channel.slug}`);
  console.log(`title: ${channel.title}`);
  console.log(`channel_id: ${channel.id}`);
  console.log(`context_path: ${channel.contextPath ?? "(none)"}`);
  console.log(`project_dir: ${projectDir}`);
  console.log(`created_at: ${channel.createdAt}`);
}

function printTasks(projectTasks: Task[], tasks: TaskQueue, channel: ProjectChannel): void {
  console.log(`\n## Tasks (${projectTasks.length})`);
  if (projectTasks.length === 0) {
    console.log("(none)");
    return;
  }

  for (const task of projectTasks) {
    const channelCheck = task.channelId
      ? task.channelId === channel.id ? "ok" : `mismatch expected=${channel.id}`
      : "missing";
    console.log(
      `- ${task.id} [${task.status}] @${task.assignedTo ?? "(unassigned)"} channel_id=${task.channelId ?? "(none)"} ${channelCheck}`,
    );
    console.log(`  title: ${task.title}`);
    console.log(`  tags: ${task.tags.join(", ") || "(none)"}`);
    console.log(`  source_message_id: ${task.sourceMessageId ?? "(none)"}`);
    console.log(`  result_len: ${task.result?.length ?? 0} error: ${preview(task.error)}`);

    const logs = tasks.getTaskLogs(task.id);
    for (const log of logs.slice(-6)) {
      console.log(`  log: ${log.createdAt} ${log.eventType} @${log.agentName ?? "-"} ${preview(log.content)}`);
    }
  }
}

function printMessages(title: string, items: TeamMessage[]): void {
  console.log(`\n## ${title} (${items.length})`);
  if (items.length === 0) {
    console.log("(none)");
    return;
  }
  for (const message of items.slice(-30)) {
    console.log(
      `- ${message.createdAt} ${message.id} [${message.channelType}:${message.channelId}] project=${message.project ?? "-"} task=${message.taskId ?? "-"} ${message.senderType}:${message.senderId} status=${message.status}`,
    );
    console.log(`  ${preview(message.content, 180)}`);
  }
}

async function listProjectFiles(projectDir: string): Promise<string[]> {
  if (!existsSync(projectDir)) return [];
  const result: string[] = [];
  await walk(projectDir, projectDir, result);
  return result.sort();
}

async function walk(root: string, current: string, result: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, result);
      continue;
    }
    const stats = statSync(fullPath);
    result.push(`${relative(root, fullPath)} (${stats.size} bytes, mtime=${stats.mtime.toISOString()})`);
  }
}

function printFiles(projectDir: string, files: string[], statusContent: string, projectTasks: Task[]): void {
  console.log(`\n## Context files (${files.length})`);
  if (!existsSync(projectDir)) {
    console.log("project directory is missing");
    return;
  }
  for (const file of files) {
    console.log(`- ${file}`);
  }

  console.log("\n## status.md checks");
  if (!statusContent) {
    console.log("status.md missing or empty");
    return;
  }
  console.log(`status.md length: ${statusContent.length}`);
  for (const task of projectTasks) {
    console.log(`- contains task ${task.id.slice(0, 8)}: ${statusContent.includes(task.id) ? "yes" : "no"}`);
  }
}

function printDiagnosis(input: {
  channel: ProjectChannel;
  projectTasks: Task[];
  visibleProjectMessages: TeamMessage[];
  orphanProjectMessages: TeamMessage[];
  coordinatorMessages: TeamMessage[];
  coderDms: TeamMessage[];
  files: string[];
  statusContent: string;
}): void {
  const findings: string[] = [];

  if (input.projectTasks.length === 0) {
    findings.push("No tasks exist in TaskQueue for this project. Coordinator likely did not call create_task, or the request was routed somewhere else.");
  }

  if (input.orphanProjectMessages.length > 0) {
    findings.push(
      `Found ${input.orphanProjectMessages.length} project messages whose project=${input.channel.slug} but channelId is not the project channel id. Web UI project channel loading will not show those messages.`,
    );
  }

  const taskChannelProblems = input.projectTasks.filter((task) => task.channelId !== input.channel.id);
  if (taskChannelProblems.length > 0) {
    findings.push(
      `Found ${taskChannelProblems.length} task(s) with missing/mismatched channelId. Worker result messages can be written to a hidden project channelId.`,
    );
  }

  const coderNaturalLanguageOnly = input.coderDms.filter((message) =>
    message.senderId === "coder" &&
    /write|document|file|create|let me/i.test(message.content) &&
    !message.taskId
  );
  if (coderNaturalLanguageOnly.length > 0) {
    findings.push(
      `Coder produced ${coderNaturalLanguageOnly.length} agent-DM reply/replies with no taskId. That means it was handling a DM, not executing a project task.`,
    );
  }

  const completedWithoutArchive = input.projectTasks.filter((task) =>
    ["completed", "failed"].includes(task.status) && !input.statusContent.includes(task.id)
  );
  if (completedWithoutArchive.length > 0) {
    findings.push(
      `${completedWithoutArchive.length} terminal task(s) are not archived in status.md. They likely ran before automatic task archival was wired, or contextHub was not passed to the worker.`,
    );
  }

  if (input.projectTasks.some((task) => task.status === "completed" && /write|document|file|create/i.test(task.result ?? "")) && input.files.length <= 3) {
    findings.push("A task result says it would write documents, but the project directory has no extra output files. The model ended in natural language without using context_write.");
  }

  if (input.projectTasks.length > 0 && input.visibleProjectMessages.length === 0) {
    findings.push("Tasks exist, but there are no messages visible through ProjectChannelStore. This points at channelId mismatch or frontend not loading the project channel.");
  }

  console.log("\n## Diagnosis");
  if (findings.length === 0) {
    console.log("No obvious consistency issue found. Check live WebSocket broadcasts and frontend selection state next.");
    return;
  }
  for (const finding of findings) {
    console.log(`- ${finding}`);
  }
}

function isAfterProjectCreated(message: TeamMessage, channel: ProjectChannel): boolean {
  return Date.parse(message.createdAt) >= Date.parse(channel.createdAt);
}

function preview(value: string | undefined, max = 120): string {
  if (!value) return "(none)";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}
