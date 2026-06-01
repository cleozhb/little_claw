import { resolve } from "node:path";

function validateToolPath(filePath: string, workspaceRoot: string): void {
  if (filePath.startsWith("~")) {
    throw new Error(
      `Access denied: "${filePath}" uses "~". Tool paths are relative to the workspace root; use a path like "tinker/runs/..." instead.`,
    );
  }

  if (!filePath.startsWith("/")) {
    const parts = filePath.split(/[\\/]+/);
    const rootParts = resolve(workspaceRoot).split(/[\\/]+/).filter(Boolean);
    if (containsSegmentSequence(parts, rootParts)) {
      throw new Error(
        `Access denied: "${filePath}" embeds the workspace root inside a relative path. Tool paths are relative to the workspace root.`,
      );
    }
  }
}

function containsSegmentSequence(parts: string[], sequence: string[]): boolean {
  if (sequence.length === 0 || parts.length < sequence.length) return false;
  for (let i = 0; i <= parts.length - sequence.length; i++) {
    if (sequence.every((segment, offset) => parts[i + offset] === segment)) {
      return true;
    }
  }
  return false;
}

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
  validateToolPath(filePath, workspaceRoot);
  const resolved = resolve(workspaceRoot, filePath);
  assertInsideWorkspace(resolved, workspaceRoot);
  return resolved;
}
