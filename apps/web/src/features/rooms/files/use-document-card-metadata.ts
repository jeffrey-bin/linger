import { useQueries } from "@tanstack/react-query";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type {
  TeamHubDocument,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";
import { documentQueryKey } from "../room-queries";
import type { DocumentCardMetadata } from "./document-card-metadata";

export function documentCardVersionQueryKey(
  tenantId: string,
  documentId: string,
  versionId: string,
) {
  return [
    "teamhub",
    tenantId,
    "document-card-version",
    documentId,
    versionId,
  ] as const;
}

export function useDocumentCardMetadata(
  client: Pick<TeamHubClient, "api">,
  tenantId: string,
  documents: Array<
    Pick<
      TeamHubDocument,
      "id" | "title" | "format" | "representation_format" | "current_version"
    >
  >,
  messages: Array<
    Pick<TeamHubMessage, "segments"> &
      Partial<Pick<TeamHubMessage, "attachments">>
  >,
  options: { documentsPending?: boolean } = {},
): Record<string, DocumentCardMetadata> {
  const referencedIds = new Set(
    messages.flatMap((message) => [
      ...(message.attachments ?? []).map(
        (attachment) => attachment.document_id,
      ),
      ...message.segments.flatMap((segment) =>
        segment.type === "document" || segment.type === "file"
          ? [segment.document_id]
          : [],
      ),
    ]),
  );
  const knownIds = new Set(documents.map((document) => document.id));
  const missingIds = [...referencedIds].filter((id) => !knownIds.has(id));
  const missingDocuments = useQueries({
    queries: missingIds.map((id) => ({
      enabled: !options.documentsPending,
      queryKey: documentQueryKey(tenantId, id),
      queryFn: async () => {
        const document = await teamHubData(
          client.api.GET("/v0/documents/{documentId}", {
            params: { path: { documentId: id } },
          }),
        );
        if (document.id !== id || document.tenant_id !== tenantId)
          throw new Error("Document metadata does not match the current Space");
        return document;
      },
      staleTime: 10_000,
      retry: false,
    })),
  });
  const availableDocuments = [
    ...documents,
    ...missingDocuments.flatMap((result) => (result.data ? [result.data] : [])),
  ];
  const versionDocuments = availableDocuments.filter(
    (document) =>
      referencedIds.has(document.id) &&
      document.format !== "blocknote" &&
      document.representation_format === "binary" &&
      document.current_version,
  );
  return useQueries({
    queries: versionDocuments.map((document) => ({
      queryKey: documentCardVersionQueryKey(
        tenantId,
        document.id,
        document.current_version!.id,
      ),
      queryFn: async () => {
        const version = await teamHubData(
          client.api.GET("/v0/document-versions/{documentVersionId}", {
            params: {
              path: { documentVersionId: document.current_version!.id },
            },
          }),
        );
        if (
          version.document_id !== document.id ||
          version.id !== document.current_version!.id
        ) {
          throw new Error(
            "Document version does not match the current Document",
          );
        }
        return version;
      },
      staleTime: 60_000,
      retry: false,
    })),
    combine: (results) => {
      const metadata: Record<string, DocumentCardMetadata> = Object.fromEntries(
        availableDocuments.map((document) => [document.id, document]),
      );
      versionDocuments.forEach((document, index) => {
        metadata[document.id] = { ...document, version: results[index]?.data };
      });
      return metadata;
    },
  });
}
