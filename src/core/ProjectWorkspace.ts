import { join, resolve } from "node:path";

export const PROJECT_CONTEXT_PREFIX = "context-hub/3-projects/";

export interface ProjectExecutionContext {
  project: string;
  channelId?: string;
  projectContextPath: string;
}

export interface ProjectChannelLookup {
  getChannel(idOrSlug: string): { contextPath?: string } | null;
}

export type ScopedToolInput =
  | { ok: true; input: Record<string, unknown>; note?: string }
  | { ok: false; error: string };

export function normalizeProjectContextPath(projectContextPath: string | undefined): string | null {
  if (!projectContextPath) return null;
  const trimmed = projectContextPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = trimmed.startsWith("3-projects/") ? `context-hub/${trimmed}` : trimmed;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return null;
  if (normalized.startsWith(PROJECT_CONTEXT_PREFIX)) return normalized;
  return null;
}

export function resolveProjectExecutionContext(input: {
  project?: string;
  channelId?: string;
  projectChannels?: ProjectChannelLookup;
}): ProjectExecutionContext | null {
  const project = input.project?.trim();
  if (!project) return null;

  const channel = input.projectChannels?.getChannel(input.channelId ?? project);
  const explicitPath = channel?.contextPath?.trim();
  const candidate = explicitPath || `${PROJECT_CONTEXT_PREFIX}${project}`;
  const projectContextPath = normalizeProjectContextPath(candidate);
  if (!projectContextPath) {
    throw new Error(
      `Project context path must be under ${PROJECT_CONTEXT_PREFIX}, got: ${candidate}`,
    );
  }

  return {
    project,
    channelId: input.channelId,
    projectContextPath,
  };
}

export function projectWorkspaceRoot(baseDir: string | undefined, projectContextPath: string | undefined): string | null {
  const normalized = normalizeProjectContextPath(projectContextPath);
  if (!baseDir || !normalized) return null;
  const relativeToBase = normalized.slice("context-hub/".length);
  return resolve(join(baseDir, "context-hub", relativeToBase));
}

export function scopeProjectWriteFileInput(
  input: Record<string, unknown>,
  projectContextPath: string | undefined,
): ScopedToolInput {
  const normalizedProjectPath = normalizeProjectContextPath(projectContextPath);
  if (!normalizedProjectPath) return { ok: true, input };

  const rawPath = input.path;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { ok: true, input };
  }

  const scopedPath = scopeProjectWritePath(rawPath, normalizedProjectPath);
  if (!scopedPath.ok) return scopedPath;
  if (scopedPath.path === rawPath) return { ok: true, input };
  return {
    ok: true,
    input: { ...input, path: scopedPath.path },
    note: `Scoped write_file path "${rawPath}" to project workspace "${scopedPath.path}".`,
  };
}

export function scopeProjectWritePath(
  rawPath: string,
  normalizedProjectPath: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const path = normalizeToolPath(rawPath);
  if (!path) return { ok: true, path: rawPath };

  if (path.startsWith("~") || path.startsWith("/") || hasParentTraversal(path)) {
    return {
      ok: false,
      error: `Project task write denied: write_file path "${rawPath}" must stay under ${normalizedProjectPath}/.`,
    };
  }

  if (path === normalizedProjectPath || path.startsWith(`${normalizedProjectPath}/`)) {
    return { ok: true, path };
  }

  const withoutContextHub = path.startsWith("context-hub/") ? path.slice("context-hub/".length) : path;
  if (withoutContextHub === normalizedProjectPath.slice("context-hub/".length)
    || withoutContextHub.startsWith(`${normalizedProjectPath.slice("context-hub/".length)}/`)
  ) {
    return { ok: true, path: `context-hub/${withoutContextHub}` };
  }

  if (path.startsWith("context-hub/") || path.startsWith("3-projects/")) {
    return {
      ok: false,
      error: `Project task write denied: write_file path "${rawPath}" is outside ${normalizedProjectPath}/.`,
    };
  }

  return { ok: true, path: `${normalizedProjectPath}/${path}` };
}

function normalizeToolPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+/g, "/");
}

function hasParentTraversal(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.includes("/../");
}
