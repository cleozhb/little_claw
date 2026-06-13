"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, RefreshCcw } from "lucide-react";

import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ProjectDocFile, ProjectDocsResult } from "@/lib/project-docs";
import { cn } from "@/lib/utils";

interface LoadedFile {
  file: ProjectDocFile;
  content: string;
}

export function ProjectDocsView({ docs }: { docs: ProjectDocsResult }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadedFile, setLoadedFile] = useState<LoadedFile | null>(null);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<ProjectDocFile[]>(docs.files);

  const loadList = useCallback(async (preferredPath?: string | null) => {
    setIsLoadingList(true);
    setError(null);
    try {
      const response = await fetch("/api/mission-control/project-docs-list", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as ProjectDocsResult;
      setFiles(data.files);
      const nextPath =
        preferredPath && data.files.some((f) => f.path === preferredPath) ? preferredPath : data.files[0]?.path ?? null;
      setSelectedPath(nextPath);
      if (!nextPath) setLoadedFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load docs.");
      setFiles([]);
      setSelectedPath(null);
      setLoadedFile(null);
    } finally {
      setIsLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (files.length === 0) return;
    const defaultPath = files[0]?.path ?? null;
    setSelectedPath(defaultPath);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedPath) return;
    const controller = new AbortController();
    setIsLoadingFile(true);
    setError(null);

    const file = files.find((f) => f.path === selectedPath);

    fetch(`/api/mission-control/project-docs?path=${encodeURIComponent(selectedPath)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response));
        const content = await response.text();
        if (!file) throw new Error("File metadata not found.");
        setLoadedFile({ file, content });
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load file content.");
        setLoadedFile(null);
      })
      .finally(() => setIsLoadingFile(false));

    return () => controller.abort();
  }, [selectedPath, files]);

  return (
    <section className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[320px_1fr]">
      <aside className="flex min-h-0 flex-col border-b md:border-b-0 md:border-r">
        <div className="shrink-0 border-b px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-semibold">Docs</h1>
              <div className="mt-1 text-xs text-muted-foreground">{docs.rootPath}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadList(selectedPath)}
              disabled={isLoadingList}
              title="Refresh docs"
            >
              <RefreshCcw className={cn("h-3.5 w-3.5", isLoadingList && "animate-spin")} />
            </Button>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
              {files.length} files
            </Badge>
            <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
              last {docs.windowDays} days
            </Badge>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {files.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
              {isLoadingList ? "Loading files" : "No recently changed project files"}
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
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
                    {file.project}
                  </Badge>
                  <Badge variant="outline" className="h-5 rounded-lg text-[10px]">
                    {formatBytes(file.size)}
                  </Badge>
                  <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
                    {formatDate(file.updatedAt)}
                  </Badge>
                </div>
                <div className="mt-2 truncate text-[10px] text-muted-foreground">{file.path}</div>
              </button>
            ))
          )}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{loadedFile?.file.name ?? "Select a file"}</div>
            <div className="truncate text-xs text-muted-foreground">{loadedFile?.file.path ?? "Project docs"}</div>
          </div>
          {loadedFile ? (
            <>
              <Badge variant="secondary" className="h-5 rounded-lg text-[10px]">
                {loadedFile.file.project}
              </Badge>
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
          ) : loadedFile ? (
            isMarkdownFile(loadedFile.file.name) ? (
              <div className="text-sm leading-6">
                <Markdown content={loadedFile.content} />
              </div>
            ) : (
              <pre className="max-h-[720px] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/30 p-3 font-mono text-xs leading-5">
                {loadedFile.content}
              </pre>
            )
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">No file selected</div>
          )}
        </div>
      </div>
    </section>
  );
}

function isMarkdownFile(name: string) {
  return name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".mdx");
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

async function readError(response: Response) {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
