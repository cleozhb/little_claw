import { parse as parseYaml } from "yaml";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import type { ParsedPersona } from "./types";

const PERSONAS_DIR = "~/.little_claw/personas";

function expandHome(dir: string): string {
  if (dir.startsWith("~/") || dir === "~") {
    return dir.replace("~", homedir());
  }
  return dir;
}

/**
 * 从 Markdown 文件内容中分离 YAML frontmatter 和 body。
 */
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

function toStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}

export class PersonaLoader {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = expandHome(baseDir ?? PERSONAS_DIR);
  }

  /**
   * 解析单个 persona .md 文件。
   */
  async parseFile(filePath: string): Promise<ParsedPersona> {
    const absolutePath = resolve(filePath);
    const file = Bun.file(absolutePath);
    if (!(await file.exists())) {
      throw new Error(`Persona file not found: ${absolutePath}`);
    }

    const content = await file.text();
    const { frontmatter, body } = splitFrontmatter(content);

    if (!frontmatter) {
      throw new Error(
        `Persona file missing YAML frontmatter: ${absolutePath}`,
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseYaml(frontmatter) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Persona YAML parse error in ${absolutePath}: ${message}`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(
        `Persona frontmatter is not a valid YAML object: ${absolutePath}`,
      );
    }

    const name = typeof parsed["name"] === "string"
      ? parsed["name"]
      : basename(absolutePath, ".md");
    const role = typeof parsed["role"] === "string" ? parsed["role"] : "";
    const emoji = typeof parsed["emoji"] === "string" ? parsed["emoji"] : "";
    const tags = toStringArray(parsed["tags"]);
    const tools = toStringArray(parsed["tools"]);

    return {
      name,
      role,
      emoji,
      tags,
      tools,
      body,
      rawContent: content,
      sourcePath: absolutePath,
    };
  }

  /**
   * 扫描 personas 目录，加载所有 .md 文件。
   */
  async loadAll(): Promise<ParsedPersona[]> {
    const results: ParsedPersona[] = [];

    try {
      const glob = new Bun.Glob("*.md");
      for await (const match of glob.scan({
        cwd: this.baseDir,
        absolute: true,
      })) {
        try {
          const persona = await this.parseFile(match);
          results.push(persona);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[PersonaLoader] Failed to load ${match}: ${message}`);
        }
      }
    } catch {
      // 目录不存在，返回空数组
    }

    return results;
  }
}

export class PersonaManager {
  private loader: PersonaLoader;
  private personas = new Map<string, ParsedPersona>();
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = expandHome(baseDir ?? PERSONAS_DIR);
    this.loader = new PersonaLoader(this.baseDir);
  }

  async initialize(): Promise<void> {
    const loaded = await this.loader.loadAll();
    this.personas.clear();
    for (const p of loaded) {
      this.personas.set(p.name, p);
    }
  }

  list(): ParsedPersona[] {
    return Array.from(this.personas.values());
  }

  get(name: string): ParsedPersona | undefined {
    return this.personas.get(name);
  }

  async create(content: string): Promise<ParsedPersona> {
    // 先解析内容获取 name，再写入文件
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

    // 确保目录存在
    await Bun.write(filePath, content);

    const persona = await this.loader.parseFile(filePath);
    this.personas.set(persona.name, persona);
    return persona;
  }

  async update(name: string, content: string): Promise<ParsedPersona> {
    const existing = this.personas.get(name);
    if (!existing) {
      throw new Error(`Persona not found: ${name}`);
    }

    await Bun.write(existing.sourcePath, content);

    const updated = await this.loader.parseFile(existing.sourcePath);
    this.personas.delete(name);
    this.personas.set(updated.name, updated);
    return updated;
  }

  async delete(name: string): Promise<void> {
    const existing = this.personas.get(name);
    if (!existing) {
      throw new Error(`Persona not found: ${name}`);
    }

    const { unlink } = await import("node:fs/promises");
    await unlink(existing.sourcePath);
    this.personas.delete(name);
  }
}
