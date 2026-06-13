import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { type NextRequest } from "next/server";

import { resolveProjectDocFile } from "@/lib/project-docs";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const relativePath = request.nextUrl.searchParams.get("path");
  if (!relativePath) {
    return Response.json({ error: "Missing project file path." }, { status: 400 });
  }

  try {
    const { absolutePath, file } = await resolveProjectDocFile(relativePath);
    const stream = createReadStream(absolutePath);

    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-File-Name": encodeURIComponent(file.name),
        "X-File-Path": encodeURIComponent(file.path),
        "X-File-Size": String(file.size),
        "X-File-Updated-At": file.updatedAt,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to read project file." },
      { status: 404 },
    );
  }
}
