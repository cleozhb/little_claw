import { parse as parseYaml } from "yaml";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import type { ParsedScenario, ScenarioPersonas, SimulationMode } from "./types";

const SCENARIOS_DIR = "~/.little_claw/scenarios";

const VALID_MODES: SimulationMode[] = [
  "roundtable",
  "parallel",
  "parallel_then_roundtable",
  "free",
];

function expandHome(dir: string): string {
  if (dir.startsWith("~/") || dir === "~") {
    return dir.replace("~", homedir());
  }
  return dir;
}

function splitFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: "", body: content };
  }

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return { frontmatter: "", body: content };
  }

  const frontmatter = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();
  return { frontmatter, body };
}

export class ScenarioLoader {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = expandHome(baseDir ?? SCENARIOS_DIR);
  }

  async parseFile(filePath: string): Promise<ParsedScenario> {
    const absolutePath = resolve(filePath);
    const file = Bun.file(absolutePath);
    if (!(await file.exists())) {
      throw new Error(`Scenario file not found: ${absolutePath}`);
    }

    const content = await file.text();
    const { frontmatter, body } = splitFrontmatter(content);

    if (!frontmatter) {
      throw new Error(
        `Scenario file missing YAML frontmatter: ${absolutePath}`,
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseYaml(frontmatter) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Scenario YAML parse error in ${absolutePath}: ${message}`,
      );
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(
        `Scenario frontmatter is not a valid YAML object: ${absolutePath}`,
      );
    }

    const name = typeof parsed["name"] === "string"
      ? parsed["name"]
      : basename(absolutePath, ".md");

    const description =
      typeof parsed["description"] === "string" ? parsed["description"] : "";

    const rawMode = typeof parsed["mode"] === "string" ? parsed["mode"] : "roundtable";
    const mode: SimulationMode = VALID_MODES.includes(rawMode as SimulationMode)
      ? (rawMode as SimulationMode)
      : "roundtable";

    const rounds =
      typeof parsed["rounds"] === "number" ? parsed["rounds"] : undefined;

    const parallelPrompt =
      typeof parsed["parallel_prompt"] === "string"
        ? parsed["parallel_prompt"]
        : "";

    const roundtablePrompt =
      typeof parsed["roundtable_prompt"] === "string"
        ? parsed["roundtable_prompt"]
        : "";

    const language =
      typeof parsed["language"] === "string" ? parsed["language"] : "";

    const worldUpdatePrompt =
      typeof parsed["world_update_prompt"] === "string"
        ? parsed["world_update_prompt"]
        : undefined;

    // --- personas ---
    let personas: ScenarioPersonas | undefined;
    const rawPersonas = parsed["personas"];
    if (rawPersonas && typeof rawPersonas === "object") {
      const rp = rawPersonas as Record<string, unknown>;
      const required = Array.isArray(rp["required"])
        ? (rp["required"] as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const optional = Array.isArray(rp["optional"])
        ? (rp["optional"] as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const max = typeof rp["max"] === "number" ? rp["max"] : undefined;
      personas = { required, optional, max };
    }

    return {
      name,
      description,
      mode,
      rounds,
      personas,
      parallelPrompt,
      roundtablePrompt,
      language,
      worldUpdatePrompt,
      body,
      rawContent: content,
      sourcePath: absolutePath,
    };
  }

  async loadAll(): Promise<ParsedScenario[]> {
    const results: ParsedScenario[] = [];

    try {
      const glob = new Bun.Glob("*.md");
      for await (const match of glob.scan({
        cwd: this.baseDir,
        absolute: true,
      })) {
        try {
          const scenario = await this.parseFile(match);
          results.push(scenario);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[ScenarioLoader] Failed to load ${match}: ${message}`,
          );
        }
      }
    } catch {
      // 目录不存在，返回空数组
    }

    return results;
  }
}

export class ScenarioManager {
  private loader: ScenarioLoader;
  private scenarios = new Map<string, ParsedScenario>();
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = expandHome(baseDir ?? SCENARIOS_DIR);
    this.loader = new ScenarioLoader(this.baseDir);
  }

  async initialize(): Promise<void> {
    const loaded = await this.loader.loadAll();
    this.scenarios.clear();
    for (const s of loaded) {
      this.scenarios.set(s.name, s);
    }
  }

  list(): ParsedScenario[] {
    return Array.from(this.scenarios.values());
  }

  get(name: string): ParsedScenario | undefined {
    return this.scenarios.get(name);
  }

  async create(content: string): Promise<ParsedScenario> {
    const { frontmatter } = splitFrontmatter(content);
    if (!frontmatter) {
      throw new Error("Content missing YAML frontmatter");
    }
    const parsed = parseYaml(frontmatter) as Record<string, unknown>;
    const name = typeof parsed["name"] === "string"
      ? parsed["name"]
      : "unnamed";
    const fileName = name.toLowerCase().replace(/\s+/g, "-") + ".md";
    const filePath = resolve(this.baseDir, fileName);

    await Bun.write(filePath, content);

    const scenario = await this.loader.parseFile(filePath);
    this.scenarios.set(scenario.name, scenario);
    return scenario;
  }

  async update(name: string, content: string): Promise<ParsedScenario> {
    const existing = this.scenarios.get(name);
    if (!existing) {
      throw new Error(`Scenario not found: ${name}`);
    }

    await Bun.write(existing.sourcePath, content);

    const updated = await this.loader.parseFile(existing.sourcePath);
    this.scenarios.delete(name);
    this.scenarios.set(updated.name, updated);
    return updated;
  }

  async delete(name: string): Promise<void> {
    const existing = this.scenarios.get(name);
    if (!existing) {
      throw new Error(`Scenario not found: ${name}`);
    }

    const { unlink } = await import("node:fs/promises");
    await unlink(existing.sourcePath);
    this.scenarios.delete(name);
  }
}
