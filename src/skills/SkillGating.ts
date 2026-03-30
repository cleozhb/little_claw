import type { ParsedSkill, GatingResult } from "./types";

const isWindows = process.platform === "win32";

/**
 * 检查某个命令行工具是否存在。
 * macOS/Linux 使用 `command -v`，Windows 使用 `where`。
 */
async function binExists(name: string): Promise<boolean> {
  try {
    const cmd = isWindows ? ["where", name] : ["command", "-v", name];
    const proc = Bun.spawn(cmd, {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * 检查配置文件路径是否存在。
 * 支持 ~ 开头的路径，展开为用户主目录。
 */
async function configExists(filePath: string): Promise<boolean> {
  const resolved = filePath.startsWith("~")
    ? filePath.replace("~", process.env["HOME"] ?? "")
    : filePath;
  return Bun.file(resolved).exists();
}

/**
 * 检查 Skill 的运行条件是否满足。
 *
 * @param skill 已解析的 Skill 定义
 * @param skillEnvOverrides 用户在配置中为该 Skill 覆盖的环境变量
 */
export async function checkGating(
  skill: ParsedSkill,
  skillEnvOverrides?: Record<string, string>,
): Promise<GatingResult> {
  const { requires } = skill;

  // 检查 env
  const missingEnv: string[] = [];
  for (const envName of requires.env) {
    const hasOverride = skillEnvOverrides?.[envName] !== undefined;
    const hasProcessEnv = process.env[envName] !== undefined;
    if (!hasOverride && !hasProcessEnv) {
      missingEnv.push(envName);
    }
  }

  // 检查 bins（全部需要存在）
  const binChecks = await Promise.all(
    requires.bins.map(async (bin) => ({
      bin,
      exists: await binExists(bin),
    })),
  );
  const missingBins = binChecks
    .filter((r) => !r.exists)
    .map((r) => r.bin);

  // 检查 anyBins（至少一个存在即可）
  if (requires.anyBins.length > 0) {
    const anyBinChecks = await Promise.all(
      requires.anyBins.map((bin) => binExists(bin)),
    );
    const anyExists = anyBinChecks.some((exists) => exists);
    if (!anyExists) {
      missingBins.push(...requires.anyBins);
    }
  }

  // 检查 config
  const configChecks = await Promise.all(
    requires.config.map(async (cfg) => ({
      cfg,
      exists: await configExists(cfg),
    })),
  );
  const missingConfig = configChecks
    .filter((r) => !r.exists)
    .map((r) => r.cfg);

  const eligible =
    missingEnv.length === 0 &&
    missingBins.length === 0 &&
    missingConfig.length === 0;

  return { eligible, missingEnv, missingBins, missingConfig };
}
