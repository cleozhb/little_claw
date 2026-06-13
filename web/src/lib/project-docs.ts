import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const PROJECTS_ROOT = path.join(homedir(), ".little_claw", "context-hub", "3-projects");
const RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const IGNORED_FILE_NAMES = new Set([".overview.md", ".abstract.md"]);

export interface ProjectDocFile {
  name: string;
  path: string;
  project: string;
  size: number;
  updatedAt: string;
}

export interface ProjectDocsResult {
  files: ProjectDocFile[];
  rootPath: string;
  scannedAt: string;
  windowDays: number;
}

export async function getRecentProjectDocs(): Promise<ProjectDocsResult> {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const files: ProjectDocFile[] = [];

  let projectEntries;
  try {
    projectEntries = await readdir(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return {
      files,
      rootPath: PROJECTS_ROOT,
      scannedAt: new Date().toISOString(),
      windowDays: 3,
    };
  }

  await Promise.all(
    projectEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => collectProjectFiles(entry.name, cutoff, files)),
  );

  files.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return {
    files,
    rootPath: PROJECTS_ROOT,
    scannedAt: new Date().toISOString(),
    windowDays: 3,
  };
}

async function collectProjectFiles(project: string, cutoff: number, files: ProjectDocFile[]) {
  const projectRoot = path.join(PROJECTS_ROOT, project);
  await walkProjectDirectory(projectRoot, project, cutoff, files);
}

async function walkProjectDirectory(
  directory: string,
  project: string,
  cutoff: number,
  files: ProjectDocFile[],
) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walkProjectDirectory(absolutePath, project, cutoff, files);
        return;
      }

      if (!entry.isFile() || IGNORED_FILE_NAMES.has(entry.name)) return;

      let fileStat;
      try {
        fileStat = await stat(absolutePath);
      } catch {
        return;
      }

      if (!fileStat.isFile() || fileStat.mtimeMs < cutoff) return;

      files.push({
        name: entry.name,
        path: path.relative(PROJECTS_ROOT, absolutePath),
        project,
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString(),
      });
    }),
  );
}

export async function resolveProjectDocFile(relativePath: string) {
  const normalizedPath = path.normalize(relativePath);
  if (
    !normalizedPath ||
    path.isAbsolute(normalizedPath) ||
    normalizedPath === ".." ||
    normalizedPath.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Invalid project file path.");
  }

  if (IGNORED_FILE_NAMES.has(path.basename(normalizedPath))) {
    throw new Error("This project file is ignored.");
  }

  const absolutePath = path.join(PROJECTS_ROOT, normalizedPath);
  const relativeFromRoot = path.relative(PROJECTS_ROOT, absolutePath);
  if (relativeFromRoot === ".." || relativeFromRoot.startsWith(`..${path.sep}`)) {
    throw new Error("Invalid project file path.");
  }

  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("Project file not found.");
  }

  return {
    absolutePath,
    file: {
      name: path.basename(absolutePath),
      path: relativeFromRoot,
      project: relativeFromRoot.split(path.sep)[0] ?? "",
      size: fileStat.size,
      updatedAt: fileStat.mtime.toISOString(),
    } satisfies ProjectDocFile,
  };
}
