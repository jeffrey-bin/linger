import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubDocument,
  TeamHubDocumentVersion,
} from "@/features/teamhub/teamhub-types";
import { verifyArtifactDownloadIntegrity } from "./artifact-download-integrity";

// Keep only the most recent small upload per client, for its first preview.
const uploads = new WeakMap<
  TeamHubClient,
  {
    documentId: string;
    versionId: string;
    file: File;
    expiresAt: number;
  }
>();

export function rememberUploadedImage(
  client: TeamHubClient,
  document: TeamHubDocument,
  file: File,
) {
  uploads.delete(client);
  if (
    !document.current_version ||
    !/^image\/(png|jpeg|gif|webp|avif)$/.test(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    return;
  uploads.set(client, {
    documentId: document.id,
    versionId: document.current_version.id,
    file,
    expiresAt: Date.now() + 5 * 60_000,
  });
}

// Call only after fetching authorized Version metadata from TeamHub.
export async function takeUploadedImage(
  client: TeamHubClient,
  version: TeamHubDocumentVersion,
): Promise<Blob | undefined> {
  const upload = uploads.get(client);
  if (!upload) return;
  if (upload.expiresAt < Date.now()) {
    uploads.delete(client);
    return;
  }
  if (
    upload.documentId !== version.document_id ||
    upload.versionId !== version.id
  )
    return;
  uploads.delete(client);
  try {
    return (
      await verifyArtifactDownloadIntegrity(version, {
        blob: upload.file,
        mediaType: upload.file.type,
      })
    ).blob;
  } catch {
    // The server may have transformed the file; use its canonical bytes instead.
    return undefined;
  }
}
