/* oxlint-disable react-doctor/async-await-in-loop -- Wiki input uploads stay sequential so quota checks and version IDs keep selection order. */

import {
  createTeamHubIdempotencyKey,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";

export const PROFILE_FILE_ACCEPT =
  ".pdf,.txt,.md,.doc,.docx,application/pdf,text/plain,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const PROFILE_FILE_MAX_COUNT = 5;

export interface UploadedProfileFile {
  inputVersionId: string;
  name: string;
}

export async function uploadProfileInputFiles(
  client: Pick<TeamHubClient, "uploadPersonalWikiDocument">,
  tenantId: string,
  files: File[],
): Promise<UploadedProfileFile[]> {
  const uploaded: UploadedProfileFile[] = [];
  for (const file of files) {
    const document = await client.uploadPersonalWikiDocument(
      tenantId,
      { file, representationFormat: profileFileRepresentation(file) },
      createTeamHubIdempotencyKey(),
    );
    if (!document.current_version) {
      throw new Error("Uploaded profile Document has no current Version.");
    }
    uploaded.push({
      inputVersionId: document.current_version.id,
      name: document.title,
    });
  }
  return uploaded;
}

function profileFileRepresentation(file: File) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".md") || file.type === "text/markdown") return "markdown";
  if (name.endsWith(".txt") || file.type === "text/plain") return "plain_text";
  return "binary";
}
