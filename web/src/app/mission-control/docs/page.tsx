import { ProjectDocsView } from "@/components/mission-control/ProjectDocsView";
import { getRecentProjectDocs } from "@/lib/project-docs";

export const dynamic = "force-dynamic";

export default async function MissionControlDocsPage() {
  const docs = await getRecentProjectDocs();
  return <ProjectDocsView docs={docs} />;
}
