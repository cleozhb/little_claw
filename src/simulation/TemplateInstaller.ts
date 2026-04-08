import { resolve, basename } from "node:path";
import { homedir } from "node:os";

const PERSONAS_DIR = resolve(homedir(), ".little_claw/personas");
const SCENARIOS_DIR = resolve(homedir(), ".little_claw/scenarios");

const TEMPLATES_DIR = resolve(import.meta.dir, "templates");
const PERSONA_TEMPLATES_DIR = resolve(TEMPLATES_DIR, "personas");
const SCENARIO_TEMPLATES_DIR = resolve(TEMPLATES_DIR, "scenarios");

/**
 * 检查目录是否为空（不存在也算空）。
 */
async function isDirEmpty(dir: string): Promise<boolean> {
  try {
    const glob = new Bun.Glob("*.md");
    for await (const _ of glob.scan({ cwd: dir })) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * 将 sourceDir 下的所有 .md 文件复制到 targetDir。
 * 目标目录会自动创建。
 */
async function copyTemplates(
  sourceDir: string,
  targetDir: string,
): Promise<string[]> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(targetDir, { recursive: true });

  const copied: string[] = [];
  const glob = new Bun.Glob("*.md");

  for await (const match of glob.scan({ cwd: sourceDir, absolute: true })) {
    const fileName = basename(match);
    const targetPath = resolve(targetDir, fileName);

    // 不覆盖已存在的文件
    const targetFile = Bun.file(targetPath);
    if (await targetFile.exists()) continue;

    const content = await Bun.file(match).text();
    await Bun.write(targetPath, content);
    copied.push(fileName);
  }

  return copied;
}

/**
 * 首次启动时检查 personas/ 和 scenarios/ 目录，
 * 如果为空则自动复制内置模板。
 *
 * @returns 复制的文件名列表（用于日志）
 */
export async function installTemplatesIfEmpty(): Promise<{
  personas: string[];
  scenarios: string[];
}> {
  const result = { personas: [] as string[], scenarios: [] as string[] };

  if (await isDirEmpty(PERSONAS_DIR)) {
    result.personas = await copyTemplates(
      PERSONA_TEMPLATES_DIR,
      PERSONAS_DIR,
    );
    if (result.personas.length > 0) {
      console.log(
        `[Simulation] Installed ${result.personas.length} persona templates: ${result.personas.join(", ")}`,
      );
    }
  }

  if (await isDirEmpty(SCENARIOS_DIR)) {
    result.scenarios = await copyTemplates(
      SCENARIO_TEMPLATES_DIR,
      SCENARIOS_DIR,
    );
    if (result.scenarios.length > 0) {
      console.log(
        `[Simulation] Installed ${result.scenarios.length} scenario templates: ${result.scenarios.join(", ")}`,
      );
    }
  }

  return result;
}
