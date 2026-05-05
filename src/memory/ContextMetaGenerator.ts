/**
 * src/memory/ContextMetaGenerator.ts — 自动生成/维护 .abstract.md 和 .overview.md
 *
 * 两种模式：
 *   1. 启动扫描：为缺少或明显过期的元文件调用 LLM 生成
 *   2. 增量更新：context_write 写入后刷新对应目录的元文件
 */

import type { LLMProvider } from "../llm/types.ts";
import type { ContextHub } from "./ContextHub.ts";

/** 不需要自动生成元文件的目录（它们有默认模板） */
const SKIP_DIRS = ["0-identity", "1-inbox"];

export class ContextMetaGenerator {
  constructor(
    private contextHub: ContextHub,
    private llmProvider: LLMProvider,
  ) {}

  /**
   * 启动时扫描所有目录，为缺少 .abstract.md 或 .overview.md 的目录生成元文件。
   */
  async scanAndGenerate(): Promise<{ generated: number }> {
    let generated = 0;
    const dirs = await this.contextHub.listDirectories();

    for (const dir of dirs) {
      const relativePath = dir.startsWith("context-hub/")
        ? dir.slice("context-hub/".length)
        : dir;

      // 跳过有默认模板的目录
      if (SKIP_DIRS.some((p) => relativePath.startsWith(p))) continue;
      // 跳过顶层没有实际内容的目录（如 2-areas/ 本身，只有子目录有内容）
      const files = await this.contextHub.listFiles(relativePath);
      if (files.length === 0) continue;

      const existingAbstract = await this.contextHub.readFile(
        `${relativePath}/.abstract.md`,
      );
      const existingOverview = await this.contextHub.readOverview(relativePath);

      if (!existingAbstract || !existingOverview || hasMissingFileEntries(existingOverview, files)) {
        const updated = await this.refreshDirectory(relativePath);
        generated += updated;
      }
    }

    return { generated };
  }

  /**
   * 刷新一个目录的 .abstract.md 和 .overview.md。
   *
   * context_write 写入项目资料后调用这里，确保 L1 索引不依赖 agent 手动维护。
   * 生成失败时使用确定性 fallback，至少保证所有文件都出现在 .overview.md 里。
   */
  async refreshDirectory(dirPath: string): Promise<number> {
    const relativePath = stripContextHubPrefix(dirPath);
    if (SKIP_DIRS.some((p) => relativePath.startsWith(p))) return 0;

    const files = await this.contextHub.listFiles(relativePath);
    if (files.length === 0) return 0;

    let updated = 0;

    const abstract =
      (await this.generateAbstract(relativePath, files)) ??
      fallbackAbstract(relativePath, files);
    if (abstract) {
      await this.contextHub.writeFile(
        `${relativePath}/.abstract.md`,
        abstract,
        "overwrite",
      );
      updated++;
    }

    const overview =
      (await this.generateOverview(relativePath, files)) ??
      (await this.fallbackOverview(relativePath, files));
    if (overview) {
      await this.contextHub.writeFile(
        `${relativePath}/.overview.md`,
        ensureOverviewListsFiles(overview, files),
        "overwrite",
      );
      updated++;
    }

    return updated;
  }

  /**
   * 基于目录名和文件列表，调用 LLM 生成一行摘要。
   */
  async generateAbstract(
    dirPath: string,
    files: string[],
  ): Promise<string | null> {
    const dirName = dirPath.split("/").pop() ?? dirPath;
    const prompt = `Generate a single line (under 100 characters) describing what this folder contains. Be concise and informative. Do not use quotes or line breaks.

Folder name: ${dirName}
Files: ${files.join(", ")}

One-line description:`;

    try {
      const messages = [{ role: "user" as const, content: prompt }];
      let result = "";
      for await (const event of this.llmProvider.chat(messages)) {
        if (event.type === "text_delta") {
          result += event.text;
        }
      }
      // 清理：取第一行，去掉引号
      const line = result.trim().split("\n")[0]?.replace(/^["']|["']$/g, "") ?? "";
      return line.slice(0, 100) || null;
    } catch {
      return null;
    }
  }

  /**
   * 基于文件列表和各文件前 200 字符，调用 LLM 生成结构化索引。
   */
  async generateOverview(
    dirPath: string,
    files: string[],
  ): Promise<string | null> {
    // 读取每个文件的前 200 字符作为上下文
    const filePreviews: string[] = [];
    for (const file of files.slice(0, 20)) {
      const content = await this.contextHub.readFile(`${dirPath}/${file}`);
      if (content) {
        const preview = content.slice(0, 200).replace(/\n/g, " ");
        filePreviews.push(`- ${file}: ${preview}`);
      } else {
        filePreviews.push(`- ${file}: (empty)`);
      }
    }

    const dirName = dirPath.split("/").pop() ?? dirPath;
    const prompt = `Generate a structured overview of this folder for AI navigation. For each file, write a one-line description. Include current status if applicable. Keep under 100 lines. Use markdown format with ## headers.

Folder: ${dirName} (${dirPath})
File previews:
${filePreviews.join("\n")}

Overview:`;

    try {
      const messages = [{ role: "user" as const, content: prompt }];
      let result = "";
      for await (const event of this.llmProvider.chat(messages)) {
        if (event.type === "text_delta") {
          result += event.text;
        }
      }
      return result.trim() || null;
    } catch {
      return null;
    }
  }

  private async fallbackOverview(
    dirPath: string,
    files: string[],
  ): Promise<string> {
    const title = titleFromDir(dirPath);
    const lines = [`# ${title}`, "", "## Key files"];

    for (const file of files) {
      const content = await this.contextHub.readFile(`${dirPath}/${file}`);
      lines.push(`- ${file} — ${describeFile(file, content)}`);
    }

    return lines.join("\n");
  }
}

function stripContextHubPrefix(path: string): string {
  return path.startsWith("context-hub/") ? path.slice("context-hub/".length) : path;
}

function hasMissingFileEntries(overview: string | null, files: string[]): boolean {
  if (!overview) return true;
  return files.some((file) => !overview.includes(file));
}

function ensureOverviewListsFiles(overview: string, files: string[]): string {
  const missing = files.filter((file) => !overview.includes(file));
  if (missing.length === 0) return overview;

  const lines = [overview.trimEnd(), "", "## Auto-indexed files"];
  for (const file of missing) {
    lines.push(`- ${file} — ${describeFile(file, null)}`);
  }
  return lines.join("\n");
}

function fallbackAbstract(dirPath: string, files: string[]): string {
  const dirName = dirPath.split("/").pop() ?? dirPath;
  return `${titleFromDir(dirName)} workspace with ${files.length} tracked file${files.length === 1 ? "" : "s"}.`;
}

function titleFromDir(dirPath: string): string {
  const dirName = dirPath.split("/").pop() ?? dirPath;
  return dirName
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function describeFile(fileName: string, content: string | null): string {
  if (fileName.endsWith(".json")) return "structured project data.";
  if (fileName === "status.md") return "current state, decisions, and next actions.";
  if (fileName.endsWith(".md")) {
    const heading = content?.match(/^#\s+(.+)$/m)?.[1]?.trim();
    return heading ? heading : "project notes.";
  }
  if (fileName.endsWith(".txt")) return "plain-text project data.";
  return "project file.";
}
