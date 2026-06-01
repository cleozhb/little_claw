import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type MemoryKind = "daily" | "identity";

interface MemoryFile {
  name: string;
  path: string;
  size: number;
  updatedAt: string;
}

const roots = {
  daily: path.join(homedir(), ".little_claw", "memory"),
  identity: path.join(homedir(), ".little_claw", "context-hub", "0-identity"),
} satisfies Record<MemoryKind, string>;

const jsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function handleMissionControlMemoryRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: jsonHeaders });
  }

  if (request.method !== "GET") {
    return json({ error: "Method not allowed." }, 405);
  }

  const url = new URL(request.url);
  const kind = parseKind(url.searchParams.get("kind"));
  const requestedPath = url.searchParams.get("path");

  if (!kind) {
    return json({ error: "Invalid memory kind." }, 400);
  }

  try {
    if (requestedPath) {
      const filePath = resolveAllowedPath(kind, requestedPath);
      const file = Bun.file(filePath);
      const [content, info] = await Promise.all([file.text(), stat(filePath)]);

      return json({
        file: {
          name: path.basename(filePath),
          path: toRelativePath(kind, filePath),
          size: info.size,
          updatedAt: info.mtime.toISOString(),
        },
        content,
      });
    }

    const files = await listFiles(kind);
    return json({ files });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load memory files.";
    const statusCode = message === "File is outside allowed memory root." ? 400 : 500;
    return json({ error: message }, statusCode);
  }
}

function parseKind(value: string | null): MemoryKind | null {
  if (value === "daily" || value === "identity") return value;
  return null;
}

async function listFiles(kind: MemoryKind): Promise<MemoryFile[]> {
  const root = roots[kind];
  const files = await walkFiles(root);
  const filtered = kind === "daily" ? files.filter((file) => file.endsWith(".jsonl")) : files;
  const details = await Promise.all(
    filtered.map(async (filePath) => {
      const info = await stat(filePath);
      return {
        name: path.basename(filePath),
        path: toRelativePath(kind, filePath),
        size: info.size,
        updatedAt: info.mtime.toISOString(),
      };
    }),
  );

  return details.sort((a, b) => {
    if (kind === "daily") return b.name.localeCompare(a.name);
    return a.path.localeCompare(b.path);
  });
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkFiles(fullPath);
      if (entry.isFile()) return [fullPath];
      return [];
    }),
  );
  return files.flat();
}

function resolveAllowedPath(kind: MemoryKind, relativePath: string) {
  const root = roots[kind];
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("File is outside allowed memory root.");
  }
  if (kind === "daily" && !resolved.endsWith(".jsonl")) {
    throw new Error("Daily logs must be .jsonl files.");
  }
  return resolved;
}

function toRelativePath(kind: MemoryKind, filePath: string) {
  return path.relative(roots[kind], filePath);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: jsonHeaders,
  });
}
