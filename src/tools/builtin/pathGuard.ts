import { resolve } from "node:path";

/**
 * 校验目标路径是否在允许的工作空间目录内，防止路径穿越攻击。
 * 将 path resolve 为绝对路径后，检查是否以 workspaceRoot 为前缀。
 */
export function assertInsideWorkspace(
  filePath: string,
  workspaceRoot: string,
): void {
  const resolved = resolve(workspaceRoot, filePath);
  const root = resolve(workspaceRoot);

  if (!resolved.startsWith(root + "/") && resolved !== root) {
    throw new Error(
      `Access denied: "${filePath}" resolves to "${resolved}", which is outside the workspace "${root}".`,
    );
  }
}

/**
 * 将用户传入的路径 resolve 为基于 workspaceRoot 的绝对路径，
 * 并确保结果在工作空间内。返回 resolve 后的绝对路径。
 */
export function resolveAndGuard(
  filePath: string,
  workspaceRoot: string,
): string {
  const resolved = resolve(workspaceRoot, filePath);
  assertInsideWorkspace(resolved, workspaceRoot);
  return resolved;
}
