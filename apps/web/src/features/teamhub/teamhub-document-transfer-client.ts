import {
  downloadTeamHubArtifactContent,
  downloadTeamHubArtifactRange,
} from "./teamhub-artifact-download";
import { uploadTeamHubFile } from "./teamhub-artifact-upload";
import type { TeamHubAuthenticationReason } from "./teamhub-authentication";
import { teamHubData, teamHubUrl, type TeamHubApi } from "./teamhub-api";
import type { TeamHubClient } from "./teamhub-client";
import type {
  TeamHubDocument,
  TeamHubDocumentVersion,
  TeamHubMessageAttachmentUpload,
} from "./teamhub-types";

export function createTeamHubDocumentTransferClient({
  api,
  baseUrl,
  fetchRequest,
  onAuthenticationRequired,
  xhrFactory,
}: {
  api: TeamHubApi;
  baseUrl: URL;
  fetchRequest: typeof fetch;
  onAuthenticationRequired: (reason: TeamHubAuthenticationReason) => void;
  xhrFactory?: () => XMLHttpRequest;
}): Pick<
  TeamHubClient,
  | "uploadPersonalWikiDocument"
  | "uploadDocumentVersion"
  | "uploadMessageAttachment"
  | "downloadLatestDocument"
  | "downloadDocumentVersion"
  | "downloadDocumentVersionRange"
  | "getDocumentVersionContentLocation"
  | "uploadRoomDocumentAssetContent"
> {
  function upload<T>(
    url: URL,
    input: Omit<
      Parameters<typeof uploadTeamHubFile>[0],
      "onAuthenticationRequired" | "url" | "xhrFactory"
    >,
  ) {
    return uploadTeamHubFile<T>({
      ...input,
      onAuthenticationRequired,
      url: url.href,
      xhrFactory,
    });
  }

  function documentVersionContentUrl(documentVersionId: string) {
    return teamHubUrl(
      baseUrl,
      "/v0/document-versions/{documentVersionId}/content",
      { path: { documentVersionId } },
    );
  }

  return {
    downloadLatestDocument: (documentId, downloadOptions) =>
      downloadTeamHubArtifactContent({
        fetchRequest,
        onAuthenticationRequired,
        options: downloadOptions,
        retryAccepted: true,
        url: teamHubUrl(baseUrl, "/v0/documents/{documentId}/downloads", {
          path: { documentId },
        }),
        verifyResponseSha256: true,
      }),
    uploadPersonalWikiDocument: (
      tenantId,
      input,
      idempotencyKey,
      uploadOptions,
    ) =>
      upload<TeamHubDocument>(
        teamHubUrl(
          baseUrl,
          "/v0/tenants/{tenantId}/personal-wiki/documents/uploads",
          { path: { tenantId } },
        ),
        {
          additionalFields: {
            representation_format: input.representationFormat,
          },
          file: input.file,
          idempotencyKey,
          parentId: input.parentId,
          ...uploadOptions,
        },
      ),
    uploadDocumentVersion: (documentId, input, idempotencyKey, uploadOptions) =>
      upload<TeamHubDocumentVersion>(
        teamHubUrl(baseUrl, "/v0/documents/{documentId}/versions", {
          path: { documentId },
        }),
        {
          additionalFields: {
            expected_current_version_id: input.expectedCurrentVersionId,
            ...(input.linkToken ? { link_token: input.linkToken } : {}),
            representation_format: input.representationFormat,
          },
          file: input.file,
          idempotencyKey,
          ...uploadOptions,
        },
      ),
    downloadDocumentVersion: (documentVersionId, downloadOptions) =>
      downloadTeamHubArtifactContent({
        fetchRequest,
        onAuthenticationRequired,
        options: downloadOptions,
        url: documentVersionContentUrl(documentVersionId),
      }),
    downloadDocumentVersionRange: (documentVersionId, rangeOptions) =>
      downloadTeamHubArtifactRange({
        fetchRequest,
        onAuthenticationRequired,
        options: rangeOptions,
        url: documentVersionContentUrl(documentVersionId),
      }),
    getDocumentVersionContentLocation: async (documentVersionId) => ({
      dispose: () => undefined,
      url: documentVersionContentUrl(documentVersionId).toString(),
    }),
    uploadMessageAttachment: (roomId, file, idempotencyKey, uploadOptions) =>
      upload<TeamHubMessageAttachmentUpload>(
        teamHubUrl(baseUrl, "/v0/rooms/{roomId}/message-attachment-uploads", {
          path: { roomId },
        }),
        { file, idempotencyKey, ...uploadOptions },
      ),
    uploadRoomDocumentAssetContent: (documentAssetId, content) =>
      teamHubData(
        api.PUT("/v0/document-assets/{documentAssetId}/content", {
          params: { path: { documentAssetId } },
          body: content as never,
          bodySerializer: (body) => body,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
  };
}
