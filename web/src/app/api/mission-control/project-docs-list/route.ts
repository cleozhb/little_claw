import { getRecentProjectDocs } from "@/lib/project-docs";

export const dynamic = "force-dynamic";

export async function GET() {
  const docs = await getRecentProjectDocs();
  return Response.json(docs);
}
