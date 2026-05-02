import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import YAML from "yaml";
import {
  getAgentTemplate,
  listAgentTemplates,
  type AgentTemplate,
} from "./AgentTemplates.ts";

export type AgentConfigStatus = "active" | "paused" | "disabled";
export type AgentRuntimeStatus = "idle" | "working" | "waiting_approval" | "paused";

export interface AgentCronJob {
  cron: string;
  prompt: string;
  key?: string;
  name?: string;
  project?: string;
  channel_id?: string;
  tags?: string[];
  priority?: number;
  max_retries?: number;
  enabled?: boolean;
}

export interface AgentWatcher {
  check_command: string;
  prompt: string;
  key?: string;
  name?: string;
  condition?: string;
  interval_minutes?: number;
  cooldown_minutes?: number;
  project?: string;
  channel_id?: string;
  tags?: string[];
  priority?: number;
  max_retries?: number;
  enabled?: boolean;
}

export interface AgentYamlConfig {
  name: string;
  display_name: string;
  emoji?: string;
  color?: string;
  role: string;
  status: AgentConfigStatus;
  aliases: string[];
  direct_message: boolean;
  default_project?: string;
  tools: string[];
  skills: string[];
  task_tags: string[];
  cron_jobs: AgentCronJob[];
  watchers?: AgentWatcher[];
  requires_approval: string[];
  max_concurrent_tasks: number;
  max_tokens_per_task: number;
  timeout_minutes: number;
}

export interface RegisteredAgent {
  config: AgentYamlConfig;
  soul: string;
  operatingInstructions: string;
  currentTasks: string[];
  status: AgentRuntimeStatus;
}

export interface AgentLoadError {
  name: string;
  path: string;
  message: string;
}

export interface CreateAgentParams {
  config: Partial<AgentYamlConfig> & Pick<AgentYamlConfig, "name" | "role">;
  soul?: string;
  operatingInstructions?: string;
}

export interface UpdateAgentParams {
  config?: Partial<AgentYamlConfig>;
  soul?: string;
  operatingInstructions?: string;
}

export interface CreateFromTemplateParams {
  templateName?: string;
  config?: Partial<AgentYamlConfig>;
  soul?: string;
  operatingInstructions?: string;
}

const DEFAULT_SOUL = `# Soul

Describe this agent's personality, tone, wording preferences, and communication style.
`;

const DEFAULT_AGENTS = `# Agent Operating Instructions

Describe how this agent should work: process, failure handling, approval rules, reporting, and handoff expectations.
`;

const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * File-backed registry for Lovely Octopus's long-lived agents.
 *
 * Each agent is a directory under ~/.little_claw/agents/{name}/ with:
 * - agent.yaml: machine-readable capabilities and routing metadata
 * - SOUL.md: persona, tone, and expression preferences
 * - AGENTS.md: operating process and execution rules
 *
 * The registry intentionally does not run agents. It only validates and loads
 * their definitions so TeamRouter, AgentWorker, and Coordinator can use them.
 */
export class AgentRegistry {
  private baseDir: string;
  private agents = new Map<string, RegisteredAgent>();
  private loadErrors: AgentLoadError[] = [];

  constructor(baseDir?: string) {
    this.baseDir = resolve(baseDir ?? join(homedir(), ".little_claw", "agents"));
  }

  /**
   * Loads every agent directory. Bad agent definitions are isolated into
   * loadErrors so one broken local config does not prevent the team from
   * starting.
   */
  loadAll(): RegisteredAgent[] {
    this.agents.clear();
    this.loadErrors = [];
    mkdirSync(this.baseDir, { recursive: true });

    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const name = entry.name;
      try {
        const agentDir = this.resolveAgentDir(name);
        const agent = this.loadAgentFromDir(agentDir);
        this.agents.set(agent.config.name, agent);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const agentDir = resolve(this.baseDir, name);
        this.loadErrors.push({ name, path: agentDir, message });
        console.warn(`[AgentRegistry] Failed to load ${name}: ${message}`);
      }
    }

    return Array.from(this.agents.values());
  }

  /**
   * Gets one agent, loading it from disk if it is not already cached.
   * Unlike loadAll(), this method throws for a malformed existing agent so the
   * caller can show a precise error when editing or inspecting that agent.
   */
  get(name: string): RegisteredAgent | null {
    this.assertValidAgentName(name);
    const loaded = this.agents.get(name);
    if (loaded) return loaded;

    const agentDir = this.resolveAgentDir(name);
    if (!existsSync(agentDir)) return null;

    const agent = this.loadAgentFromDir(agentDir);
    this.agents.set(agent.config.name, agent);
    return agent;
  }

  /**
   * Creates an agent directory and any missing files. Existing files are never
   * overwritten because SOUL.md and AGENTS.md are expected to be hand-edited.
   */
  create(name: string, params: CreateAgentParams): RegisteredAgent {
    this.assertValidAgentName(name);
    if (params.config.name !== name) {
      throw new Error(`Agent config name "${params.config.name}" must match directory name "${name}".`);
    }

    const agentDir = this.resolveAgentDir(name);
    mkdirSync(agentDir, { recursive: true });

    const config = normalizeConfig(params.config);
    this.writeFileIfMissing(
      join(agentDir, "agent.yaml"),
      YAML.stringify(config),
    );
    this.writeFileIfMissing(join(agentDir, "SOUL.md"), params.soul ?? DEFAULT_SOUL);
    this.writeFileIfMissing(
      join(agentDir, "AGENTS.md"),
      params.operatingInstructions ?? DEFAULT_AGENTS,
    );

    const agent = this.loadAgentFromDir(agentDir);
    this.agents.set(agent.config.name, agent);
    return agent;
  }

  /**
   * Creates an agent from a built-in template. The agent name can either match
   * the template name or be a new name using templateName plus overrides.
   */
  createFromTemplate(name: string, params: CreateFromTemplateParams = {}): RegisteredAgent {
    this.assertValidAgentName(name);
    const templateName = params.templateName ?? name;
    const template = getAgentTemplate(templateName);
    if (!template) {
      throw new Error(
        `Unknown agent template "${templateName}". Available templates: ${listAgentTemplates()
          .map((item) => item.name)
          .join(", ")}.`,
      );
    }

    const config: AgentYamlConfig = normalizeConfig({
      ...template.config,
      ...params.config,
      name,
      display_name: params.config?.display_name ?? template.config.display_name,
    });

    return this.create(name, {
      config,
      soul: params.soul ?? template.soul,
      operatingInstructions: params.operatingInstructions ?? template.operatingInstructions,
    });
  }

  listTemplates(): AgentTemplate[] {
    return listAgentTemplates();
  }

  /**
   * Updates one or more of the three agent definition files. The directory name
   * remains the stable identity, so agent.yaml name changes are rejected here.
   */
  update(name: string, updates: UpdateAgentParams): RegisteredAgent {
    this.assertValidAgentName(name);
    const agentDir = this.resolveAgentDir(name);
    if (!existsSync(agentDir)) {
      throw new Error(`Agent not found: ${name}`);
    }

    const current = this.loadAgentFromDir(agentDir);

    if (updates.config) {
      const nextName = updates.config.name ?? current.config.name;
      if (nextName !== name) {
        throw new Error(`Agent config name "${nextName}" must match directory name "${name}".`);
      }
      const nextConfig = normalizeConfig({
        ...current.config,
        ...updates.config,
        name,
      });
      writeFileSync(join(agentDir, "agent.yaml"), YAML.stringify(nextConfig), "utf8");
    }

    if (updates.soul !== undefined) {
      writeFileSync(join(agentDir, "SOUL.md"), updates.soul, "utf8");
    }

    if (updates.operatingInstructions !== undefined) {
      writeFileSync(join(agentDir, "AGENTS.md"), updates.operatingInstructions, "utf8");
    }

    const updated = this.loadAgentFromDir(agentDir);
    this.agents.set(updated.config.name, updated);
    return updated;
  }

  /**
   * Deletes an agent only when the caller has performed explicit confirmation.
   * This keeps the low-level API usable while preventing accidental destructive
   * calls from UI or command routing code.
   */
  delete(name: string, confirmed = false): void {
    this.assertValidAgentName(name);
    if (!confirmed) {
      throw new Error(`Deleting agent "${name}" requires explicit confirmation.`);
    }

    const agentDir = this.resolveAgentDir(name);
    if (!existsSync(agentDir)) return;

    rmSync(agentDir, { recursive: true, force: true });
    this.agents.delete(name);
  }

  listActive(): RegisteredAgent[] {
    return Array.from(this.agents.values()).filter(
      (agent) => agent.config.status === "active",
    );
  }

  listAll(): RegisteredAgent[] {
    return Array.from(this.agents.values());
  }

  getLoadErrors(): AgentLoadError[] {
    return [...this.loadErrors];
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  /** Reads and validates the three files that make up a single agent. */
  private loadAgentFromDir(agentDir: string): RegisteredAgent {
    this.assertInsideBase(agentDir);
    const dirName = basename(agentDir);
    this.assertValidAgentName(dirName);

    const configPath = join(agentDir, "agent.yaml");
    const soulPath = join(agentDir, "SOUL.md");
    const agentsPath = join(agentDir, "AGENTS.md");

    this.assertRequiredFile(configPath, "agent.yaml");
    this.assertRequiredFile(soulPath, "SOUL.md");
    this.assertRequiredFile(agentsPath, "AGENTS.md");

    const rawConfig = YAML.parse(readFileSync(configPath, "utf8")) as unknown;
    const config = normalizeConfig(rawConfig);
    if (config.name !== dirName) {
      throw new Error(`agent.yaml name "${config.name}" must match directory name "${dirName}".`);
    }

    const soul = readFileSync(soulPath, "utf8");
    const operatingInstructions = readFileSync(agentsPath, "utf8");

    return {
      config,
      soul,
      operatingInstructions,
      currentTasks: [],
      status: config.status === "active" ? "idle" : "paused",
    };
  }

  /** Resolves a user-facing agent name into an on-disk directory safely. */
  private resolveAgentDir(name: string): string {
    this.assertValidAgentName(name);
    const resolved = resolve(this.baseDir, name);
    this.assertInsideBase(resolved);
    return resolved;
  }

  /** Guards against path traversal and accidental writes outside the registry. */
  private assertInsideBase(path: string): void {
    const resolved = resolve(path);
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + "/")) {
      throw new Error(`Path "${path}" is outside agent registry "${this.baseDir}".`);
    }
  }

  private assertValidAgentName(name: string): void {
    if (!AGENT_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid agent name "${name}". Use letters, numbers, underscore, or hyphen, and start with a letter or number.`,
      );
    }
  }

  private assertRequiredFile(path: string, label: string): void {
    if (!existsSync(path)) {
      throw new Error(`Missing required ${label} at ${path}.`);
    }
    if (!statSync(path).isFile()) {
      throw new Error(`Expected ${label} to be a file: ${path}.`);
    }
  }

  private writeFileIfMissing(path: string, content: string): void {
    if (existsSync(path)) return;
    writeFileSync(path, content, "utf8");
  }
}

/**
 * Normalizes a partial YAML object into the full runtime config shape.
 * Defaults live here so all create/load/update paths produce consistent
 * AgentYamlConfig objects.
 */
function normalizeConfig(raw: unknown): AgentYamlConfig {
  if (!isRecord(raw)) {
    throw new Error("agent.yaml must contain a YAML object.");
  }

  const name = readRequiredString(raw, "name");
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid agent name "${name}" in agent.yaml.`);
  }

  const role = readRequiredString(raw, "role");
  const status = readStatus(raw.status);
  const maxConcurrentTasks = readPositiveInteger(raw.max_concurrent_tasks, 1, "max_concurrent_tasks");
  const maxTokensPerTask = readPositiveInteger(raw.max_tokens_per_task, 50000, "max_tokens_per_task");
  const timeoutMinutes = readPositiveInteger(raw.timeout_minutes, 30, "timeout_minutes");

  return {
    name,
    display_name: readOptionalString(raw.display_name) ?? name,
    emoji: readOptionalString(raw.emoji),
    color: readOptionalString(raw.color),
    role,
    status,
    aliases: readStringArray(raw.aliases, "aliases"),
    direct_message: readBoolean(raw.direct_message, true, "direct_message"),
    default_project: readOptionalString(raw.default_project),
    tools: readStringArray(raw.tools, "tools"),
    skills: readStringArray(raw.skills, "skills"),
    task_tags: readStringArray(raw.task_tags, "task_tags"),
    cron_jobs: readCronJobs(raw.cron_jobs),
    watchers: readWatchers(raw.watchers),
    requires_approval: readStringArray(raw.requires_approval, "requires_approval"),
    max_concurrent_tasks: maxConcurrentTasks,
    max_tokens_per_task: maxTokensPerTask,
    timeout_minutes: timeoutMinutes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`agent.yaml field "${key}" must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("Optional string field must be a string when provided.");
  }
  return value;
}

function readStatus(value: unknown): AgentConfigStatus {
  if (value === undefined || value === null) return "active";
  if (value === "active" || value === "paused" || value === "disabled") {
    return value;
  }
  throw new Error('agent.yaml field "status" must be active, paused, or disabled.');
}

function readBoolean(value: unknown, fallback: boolean, key: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`agent.yaml field "${key}" must be a boolean.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, fallback: number, key: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`agent.yaml field "${key}" must be a positive integer.`);
  }
  return value;
}

function readStringArray(value: unknown, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`agent.yaml field "${key}" must be an array of strings.`);
  }
  return [...value];
}

function readOptionalStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return readStringArray(value, key);
}

function readOptionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`agent.yaml field "${key}" must be a boolean.`);
  }
  return value;
}

function readOptionalInteger(value: unknown, key: string, options: { min?: number } = {}): number | undefined {
  if (value === undefined || value === null) return undefined;
  const min = options.min ?? 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`agent.yaml field "${key}" must be an integer >= ${min}.`);
  }
  return value;
}

function readCronJobs(value: unknown): AgentCronJob[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('agent.yaml field "cron_jobs" must be an array.');
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`cron_jobs[${index}] must be an object.`);
    }
    const cron = readRequiredString(item, "cron");
    const prompt = readRequiredString(item, "prompt");
    return {
      cron,
      prompt,
      key: readOptionalString(item.key),
      name: readOptionalString(item.name),
      project: readOptionalString(item.project),
      channel_id: readOptionalString(item.channel_id),
      tags: readOptionalStringArray(item.tags, `cron_jobs[${index}].tags`),
      priority: readOptionalInteger(item.priority, `cron_jobs[${index}].priority`),
      max_retries: readOptionalInteger(item.max_retries, `cron_jobs[${index}].max_retries`),
      enabled: readOptionalBoolean(item.enabled, `cron_jobs[${index}].enabled`),
    };
  });
}

function readWatchers(value: unknown): AgentWatcher[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('agent.yaml field "watchers" must be an array.');
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`watchers[${index}] must be an object.`);
    }
    const checkCommand = readRequiredString(item, "check_command");
    const prompt = readRequiredString(item, "prompt");
    return {
      check_command: checkCommand,
      prompt,
      key: readOptionalString(item.key),
      name: readOptionalString(item.name),
      condition: readOptionalString(item.condition),
      interval_minutes: readOptionalInteger(item.interval_minutes, `watchers[${index}].interval_minutes`, { min: 1 }),
      cooldown_minutes: readOptionalInteger(item.cooldown_minutes, `watchers[${index}].cooldown_minutes`, { min: 0 }),
      project: readOptionalString(item.project),
      channel_id: readOptionalString(item.channel_id),
      tags: readOptionalStringArray(item.tags, `watchers[${index}].tags`),
      priority: readOptionalInteger(item.priority, `watchers[${index}].priority`),
      max_retries: readOptionalInteger(item.max_retries, `watchers[${index}].max_retries`),
      enabled: readOptionalBoolean(item.enabled, `watchers[${index}].enabled`),
    };
  });
}
