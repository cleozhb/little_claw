"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, CalendarDays, FileJson, FileText, RefreshCcw } from "lucide-react";

import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type MemoryKind = "daily" | "identity";

interface MemoryFile {
  name: string;
  path: string;
  size: number;
  updatedAt: string;
}

interface LoadedFile {
  file: MemoryFile;
  content: string;
}

interface JsonLine {
  line: number;
  parsed: Record<string, unknown> | null;
  raw: string;
}

const tabs: Array<{ kind: MemoryKind; label: string; icon: typeof CalendarDays }> = [
  { kind: "daily", label: "Daily Log", icon: CalendarDays },
  { kind: "identity", label: "长期记忆", icon: BookOpen },
];

const MEMORY_API_BASE_URL =
  process.env.NEXT_PUBLIC_GATEWAY_HTTP_URL ??
  gatewayHttpUrlFromWebSocketUrl(process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:4000/ws");

export function MemoryView() {
  const [kind, setKind] = useState<MemoryKind>("daily");
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadedFile, setLoadedFile] = useState<LoadedFile | null>(null);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async (nextKind: MemoryKind, preferredPath?: string | null) => {
    setIsLoadingList(true);
    setError(null);
    try {
      const response = await fetch(memoryApiUrl({ kind: nextKind }));
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as { files: MemoryFile[] };
      setFiles(data.files);
      const nextPath = preferredPath && data.files.some((file) => file.path === preferredPath)
        ? preferredPath
        : data.files[0]?.path ?? null;
      setSelectedPath(nextPath);
      if (!nextPath) setLoadedFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load memory files.");
      setFiles([]);
      setSelectedPath(null);
      setLoadedFile(null);
    } finally {
      setIsLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadList(kind);
  }, [kind, loadList]);

  useEffect(() => {
    if (!selectedPath) return;
    const controller = new AbortController();
    setIsLoadingFile(true);
    setError(null);

    fetch(memoryApiUrl({ kind, path: selectedPath }), {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response));
        return response.json() as Promise<LoadedFile>;
      })
      .then((data) => setLoadedFile(data))
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load memory content.");
        setLoadedFile(null);
      })
      .finally(() => setIsLoadingFile(false));

    return () => controller.abort();
  }, [kind, selectedPath]);

  const parsedLines = useMemo(() => {
    if (kind !== "daily" || !loadedFile?.content) return [];
    return parseJsonLines(loadedFile.content);
  }, [kind, loadedFile?.content]);

  return (
    <section className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[320px_1fr]">
      <aside className="flex min-h-0 flex-col border-b md:border-b-0 md:border-r">
        <div className="shrink-0 border-b px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-semibold">Memory</h1>
              <div className="mt-1 text-xs text-muted-foreground">
                {kind === "daily" ? "~/.little_claw/memory" : "~/.little_claw/context-hub/0-identity"}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadList(kind, selectedPath)}
              disabled={isLoadingList}
              title="Refresh memory files"
            >
              <RefreshCcw className={cn("h-3.5 w-3.5", isLoadingList && "animate-spin")} />
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.kind}
                  type="button"
                  onClick={() => setKind(tab.kind)}
                  className={cn(
                    "flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
                    kind === tab.kind
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {files.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
              {isLoadingList ? "Loading files" : "No files found"}
            </div>
          ) : (
            files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedPath(file.path)}
                className={cn(
                  "w-full rounded-lg border p-3 text-left transition-colors",
                  selectedPath === file.path ? "bg-accent" : "hover:bg-muted/60",
                )}
              >
                <div className="flex items-center gap-2">
                  {kind === "daily" ? (
                    <FileJson className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
                    {formatBytes(file.size)}
                  </Badge>
                  <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
                    {formatDate(file.updatedAt)}
                  </Badge>
                </div>
                {file.path !== file.name ? (
                  <div className="mt-2 truncate text-[10px] text-muted-foreground">{file.path}</div>
                ) : null}
              </button>
            ))
          )}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{loadedFile?.file.name ?? "Select a memory file"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {loadedFile?.file.path ?? (kind === "daily" ? "Daily logs" : "Identity memory")}
            </div>
          </div>
          {loadedFile ? (
            <>
              <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
                {formatBytes(loadedFile.file.size)}
              </Badge>
              <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
                {formatDate(loadedFile.file.updatedAt)}
              </Badge>
            </>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {error}
            </div>
          ) : isLoadingFile ? (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">Loading content</div>
          ) : kind === "daily" && loadedFile ? (
            <DailyLogDetails lines={parsedLines} />
          ) : loadedFile ? (
            <div className="text-sm leading-6">
              <Markdown content={loadedFile.content} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">No file selected</div>
          )}
        </div>
      </div>
    </section>
  );
}

function memoryApiUrl(params: { kind: MemoryKind; path?: string }) {
  const url = new URL("/api/mission-control/memory", MEMORY_API_BASE_URL);
  url.searchParams.set("kind", params.kind);
  if (params.path) url.searchParams.set("path", params.path);
  return url.toString();
}

function gatewayHttpUrlFromWebSocketUrl(wsUrl: string) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function DailyLogDetails({ lines }: { lines: JsonLine[] }) {
  if (lines.length === 0) {
    return <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">No log entries</div>;
  }

  return (
    <div className="space-y-3">
      {lines.map((line) => {
        const role = getString(line.parsed?.role);
        const ts = getString(line.parsed?.ts);
        const content = formatContent(line.parsed?.content ?? line.raw);
        return (
          <article key={line.line} className="rounded-lg border bg-background p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={role === "assistant" ? "secondary" : "outline"} className="h-5 rounded-lg text-[10px]">
                {role || `line ${line.line}`}
              </Badge>
              {ts ? <span className="text-[10px] text-muted-foreground">{formatFullDate(ts)}</span> : null}
            </div>
            <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 font-mono text-xs leading-5">
              {content}
            </pre>
          </article>
        );
      })}
    </div>
  );
}

async function readError(response: Response) {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

function parseJsonLines(content: string): JsonLine[] {
  return content
    .split(/\r?\n/)
    .map((raw, index) => ({ raw, line: index + 1 }))
    .filter(({ raw }) => raw.trim().length > 0)
    .map(({ raw, line }) => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return { line, raw, parsed };
      } catch {
        return { line, raw, parsed: null };
      }
    });
}

function formatContent(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatFullDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
