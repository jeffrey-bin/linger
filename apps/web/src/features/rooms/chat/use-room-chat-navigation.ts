import { preloadDocumentEditor } from "../documents/document-editor-preload";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useSearchParams } from "react-router";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import {
  TeamHubError,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import type {
  TeamHubActorRef,
  TeamHubDocument,
  TeamHubDocumentPage,
  TeamHubDocumentVersion,
  TeamHubMessage,
  TeamHubMessageDocumentSegment,
  TeamHubMessageFileSegment,
} from "@/features/teamhub/teamhub-types";

import { useRoomOutletContext } from "../room-connectivity";
import { artifactPreviewCache } from "../files/artifact-preview-cache";
import { prefetchArtifactPreview } from "../files/artifact-preview-loader";
import { documentCardVersionQueryKey } from "../files/use-document-card-metadata";
import type { RoomComposerDocumentContext } from "../room-drafts";

import type { MessageDocumentOption } from "./message-composer-references";
import { patchRoomMessageThread } from "./room-projection";
import { requestThreadComposerFocus } from "./thread-composer-focus";
import {
  documentQueryKey,
  documentQueryOptions,
  roomDocumentsQueryKey,
} from "../room-queries";

/**
 * Chat → Panel bridge.
 * Thread, Task Run, and file previews open in the Room panel.
 */
export function useRoomChatNavigation(
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { openPanelTab } = useRoomOutletContext();

  return useMemo(() => {
    function clearProfileParam() {
      if (!searchParams.has("profile")) {
        return;
      }
      const next = new URLSearchParams(searchParams);
      next.delete("profile");
      setSearchParams(next);
    }

    function knownRoomDocument(documentId: string) {
      return (
        queryClient.getQueryData<TeamHubDocument>(
          documentQueryKey(tenantId, documentId),
        ) ??
        queryClient
          .getQueryData<TeamHubDocumentPage>(
            roomDocumentsQueryKey(tenantId, roomId),
          )
          ?.items.find((document) => document.id === documentId)
      );
    }

    // Immutable card metadata selects which bytes to fetch alongside open.
    // Display still waits for the fresh open, which must name this Version.
    function prefetchCurrentVersion(
      knownDocument: TeamHubDocument | undefined,
    ) {
      const knownVersionId = knownDocument?.current_version?.id;
      if (
        !knownDocument ||
        knownDocument.tenant_id !== tenantId ||
        !knownVersionId
      )
        return;
      const knownVersion = queryClient.getQueryData<TeamHubDocumentVersion>(
        documentCardVersionQueryKey(tenantId, knownDocument.id, knownVersionId),
      );
      if (
        knownVersion?.id === knownVersionId &&
        knownVersion.document_id === knownDocument.id
      )
        prefetchArtifactPreview({ client, version: knownVersion });
    }

    function previewDocument(target: {
      current_version?: { id?: string } | null;
      id: string;
      title: string;
    }) {
      // Without a Version the panel opens the current Document through /open,
      // which gates display and clears prefetched bytes when denied.
      if (!target.current_version?.id)
        prefetchCurrentVersion(knownRoomDocument(target.id));
      openPanelTab({
        kind: "file",
        documentId: target.id,
        title: target.title,
        versionId: target.current_version?.id,
      });
    }

    return {
      closeLinkedMessage() {
        const next = new URLSearchParams(searchParams);
        next.delete("message");
        next.delete("highlight");
        setSearchParams(next);
      },
      linkedMessageId: searchParams.get("message"),
      // Global search hands over the keyword it matched so the linked Message
      // can show it as selected text.
      linkedMessageHighlight: searchParams.get("highlight"),
      openLiveActivity(
        agent: { display_name: string; id: string },
        runStatusId: string,
        runId?: string,
        activityRoomId = roomId,
        sourceMessageId?: string,
      ) {
        openPanelTab({
          kind: "agentActivity",
          activityRunStatusId: runStatusId || undefined,
          activityRunId: runId,
          activityRoomId,
          anchorMessageId: sourceMessageId,
          actorId: agent.id,
          title: `Activity · ${agent.display_name}`,
        });
        clearProfileParam();
      },
      openAgentActivity(
        agent: { display_name: string; id: string },
        activityRoomId = roomId,
      ) {
        openPanelTab({
          kind: "agentActivity",
          actorId: agent.id,
          activityRoomId,
          title: `Activity · ${agent.display_name}`,
        });
        clearProfileParam();
      },
      openAgentInfo(actor: TeamHubActorRef) {
        openPanelTab({
          kind: "agentInfo",
          actorId: actor.id,
          title: `Agent · ${actor.display_name}`,
        });
        clearProfileParam();
      },
      openDocumentContext(context: RoomComposerDocumentContext) {
        previewDocument({
          id: context.documentId,
          title: context.filename,
        });
      },
      openDocument(document: MessageDocumentOption) {
        previewDocument({ id: document.documentId, title: document.name });
      },
      async openMessageFile(
        segment: TeamHubMessageFileSegment | TeamHubMessageDocumentSegment,
      ) {
        const knownDocument = knownRoomDocument(segment.document_id);
        // Code preparation may use known server metadata; access still requires the fresh open below.
        if (
          segment.type === "document" &&
          knownDocument?.tenant_id === tenantId &&
          knownDocument.format === "blocknote" &&
          knownDocument.representation_format !== "html"
        )
          void preloadDocumentEditor().catch(() => undefined);
        prefetchCurrentVersion(knownDocument);
        // Do not expose a previously cached detail while access may have changed.
        // The message reference is not an authorization grant.
        queryClient.removeQueries({
          queryKey: documentQueryKey(tenantId, segment.document_id),
          exact: true,
        });
        if (segment.type === "document") {
          // The mounted Document viewer owns fresh authorization and session creation.
          openPanelTab({
            kind: "file",
            documentId: segment.document_id,
            title: segment.content,
          });
          return;
        }
        // Open the loading panel immediately. Its query shares this key, so the
        // metadata read below and the panel cannot issue duplicate GETs.
        openPanelTab({
          kind: "file",
          documentId: segment.document_id,
          title: segment.filename ?? segment.content,
          previewCurrentVersion: true,
        });
        void queryClient
          .fetchQuery({
            ...documentQueryOptions(client, tenantId, segment.document_id),
            retry: false,
          })
          .then((document) => {
            if (document.status === "active") {
              cacheRoomDocument(queryClient, tenantId, roomId, document);
            }
          })
          .catch((error: unknown) => {
            // Bytes prefetched on click must not outlive a denied read.
            if (
              error instanceof TeamHubError &&
              [401, 403, 404].includes(error.status)
            )
              artifactPreviewCache.clear();
            // The panel owns the error state (including 403/404) and retry UI.
          });
      },
      previewArtifact: previewDocument,
      openProfile(actorId: string) {
        const next = new URLSearchParams(searchParams);
        next.set("profile", actorId);
        setSearchParams(next);
      },
      openThread(
        message: TeamHubMessage,
        options?: { focusComposer?: boolean },
      ) {
        requestThreadComposerFocus(options?.focusComposer ? message.id : null);
        openPanelTab({
          kind: "thread",
          anchorMessageId: message.id,
          title: message.raw_message,
        });
        clearProfileParam();
        void (async () => {
          try {
            const thread = await teamHubData(
              client.api.POST(
                "/v0/rooms/{roomId}/messages/{messageId}/thread",
                { params: { path: { roomId, messageId: message.id } } },
              ),
            );
            patchRoomMessageThread(queryClient, tenantId, roomId, message.id, {
              room_id: thread.room.id,
              reply_count: message.thread?.reply_count ?? 0,
              ...(message.thread?.latest_reply_at
                ? { latest_reply_at: message.thread.latest_reply_at }
                : {}),
              ...(message.thread?.latest_reply_authors
                ? { latest_reply_authors: message.thread.latest_reply_authors }
                : {}),
            });
          } catch {
            return;
          }
        })();
      },
    };
  }, [
    client,
    tenantId,
    roomId,
    queryClient,
    searchParams,
    setSearchParams,
    openPanelTab,
  ]);
}

function cacheRoomDocument(
  queryClient: ReturnType<typeof useQueryClient>,
  tenantId: string,
  roomId: string,
  document: TeamHubDocument,
) {
  queryClient.setQueryData<TeamHubDocumentPage>(
    roomDocumentsQueryKey(tenantId, roomId),
    (current) => ({
      items: [
        ...(current?.items.filter(
          (candidate) => candidate.id !== document.id,
        ) ?? []),
        document,
      ],
      page: current?.page ?? { has_more: false },
    }),
  );
}
