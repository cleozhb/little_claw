import { parse as parseYaml } from "yaml";
import { dirname, basename, resolve } from "node:path";
import type { ParsedSkill, SkillRequires } from "./types";

/** 支持的 metadata 命名空间别名 */
const METADATA_KEYS = ["openclaw", "clawdbot", "clawdis"] as const;

/**
 * 从 SKILL.md 文件内容中分离 YAML frontmatter 和 Markdown body。
 * frontmatter 以 `---` 开头和结尾。
 */
function splitFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: "", body: content };
  }

  // 找到第二个 ---
  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return { frontmatter: "", body: content };
  }

  const frontmatter = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();
  return { frontmatter, body };
}

/**
 * 从 frontmatter 的 metadata 中查找 OpenClaw 兼容的命名空间。
 * 支持 metadata.openclaw / metadata.clawdbot / metadata.clawdis
 */
function extractMetadataNamespace(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;

  for (const key of METADATA_KEYS) {
    const ns = metadata[key];
    if (ns && typeof ns === "object") {
      return ns as Record<string, unknown>;
    }
  }
  return undefined;
}

function toStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}

function parseRequires(raw: unknown): SkillRequires {
  const defaults: SkillRequires = {
    env: [],
    bins: [],
    anyBins: [],
    config: [],
  };
  if (!raw || typeof raw !== "object") return defaults;

  const obj = raw as Record<string, unknown>;
  return {
    env: toStringArray(obj["env"]),
    bins: toStringArray(obj["bins"]),
    anyBins: toStringArray(obj["anyBins"] ?? obj["any_bins"]),
    config: toStringArray(obj["config"]),
  };
}

export class SkillMarkdownParser {
  /**
   * 解析 SKILL.md 文件并返回 ParsedSkill。
   * @param filePath SKILL.md 文件的绝对路径
   */
  async parse(filePath: string): Promise<ParsedSkill> {
    const absolutePath = resolve(filePath);
    const dir = dirname(absolutePath);
    const dirName = basename(dir);

    // 读取文件
    const file = Bun.file(absolutePath);
    const exists = await file.exists();
    if (!exists) {
      throw new Error(
        `SKILL.md not found: ${absolutePath}`,
      );
    }

    const content = await file.text();

    // 分离 frontmatter 和 body
    const { frontmatter, body } = splitFrontmatter(content);

    if (!frontmatter) {
      throw new Error(
        `SKILL.md missing YAML frontmatter (expected --- delimiters): ${absolutePath}`,
      );
    }

    // 解析 YAML
    let parsed: Record<string, unknown>;
    try {
      parsed = parseYaml(frontmatter) as Record<string, unknown>;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      throw new Error(
        `SKILL.md YAML parse error in ${absolutePath}: ${message}`,
      );
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(
        `SKILL.md frontmatter is not a valid YAML object: ${absolutePath}`,
      );
    }

    // 提取顶层字段
    const name =
      typeof parsed["name"] === "string" ? parsed["name"] : dirName;
    const description =
      typeof parsed["description"] === "string" ? parsed["description"] : "";
    const version =
      typeof parsed["version"] === "string" ? parsed["version"] : "0.0.0";
    const author =
      typeof parsed["author"] === "string" ? parsed["author"] : undefined;
    const tags = Array.isArray(parsed["tags"])
      ? parsed["tags"].filter((t): t is string => typeof t === "string")
      : undefined;

    // 从 metadata 命名空间中提取 requires、primaryEnv、emoji
    const metadata = parsed["metadata"] as
      | Record<string, unknown>
      | undefined;
    const ns = extractMetadataNamespace(metadata);

    const requires = parseRequires(ns?.["requires"]);
    const primaryEnv =
      typeof ns?.["primaryEnv"] === "string"
        ? ns["primaryEnv"]
        : typeof ns?.["primary_env"] === "string"
          ? (ns["primary_env"] as string)
          : undefined;

    // emoji: 优先从 metadata 命名空间取，其次从顶层取
    const emoji =
      typeof ns?.["emoji"] === "string"
        ? ns["emoji"]
        : typeof parsed["emoji"] === "string"
          ? parsed["emoji"]
          : undefined;

    if (!description) {
      throw new Error(
        `SKILL.md missing required field 'description': ${absolutePath}`,
      );
    }

    return {
      name,
      description,
      version,
      emoji,
      author,
      tags,
      requires,
      primaryEnv,
      instructions: body,
      sourcePath: dir,
    };
  }
}
