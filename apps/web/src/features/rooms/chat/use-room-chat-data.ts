import {
  useQueryClient,
  useQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { loadAllManifestPages } from "@/features/rooms/members/agent-resource-catalog";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActor,
  TeamHubDocument,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

import { requireRoomRouteParam } from "../room-route-params";
import { useRoomOutletContext } from "../room-connectivity";
import { readRoomComposerDraft } from "../room-drafts";
import {
  roomMembersQueryOptions,
  roomDocumentsQueryOptions,
  roomMessageQueryOptions,
  roomMessagesInfiniteQueryOptions,
  roomQueryOptions,
  teamHubIdentityQueryOptions,
  tenantActorsQueryOptions,
} from "../room-queries";
import { registerVoiceRoomFiles } from "./voice-mode/voice-ui-bridge";
import { useComposerDocumentOptions } from "./use-composer-document-options";
import { useRoomChatNavigation } from "./use-room-chat-navigation";
import { roomMessageSender } from "./room-message-sender";

const EMPTY_TENANT_ACTORS: TeamHubActor[] = [];
const EMPTY_ROOM_DOCUMENTS: TeamHubDocument[] = [];

/** Reads the route, outlet context and TeamHub queries the Room chat renders. */
export function useRoomChatData() {
  const { client } = useTeamHubRuntime();
  const composition = roomMessageSender(client);
  const params = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");
  const roomId = requireRoomRouteParam(params.roomId, "Room");
  const [forwardMessage, setForwardMessage] = useState<TeamHubMessage | null>(
    null,
  );
  const navigation = useRoomChatNavigation(client, tenantId, roomId);
  const {
    lastAppliedRoomSeq,
    messagePresentations: roomMessagePresentations,
    openPanelTab,
    prefetchPanel,
    recordMessagePresentation,
  } = useRoomOutletContext();
  const linkedMessageId = navigation.linkedMessageId;
  const openDocument = navigation.openDocument;
  // Live voice opens a Document this Room has beside its chat.
  useEffect(
    () =>
      registerVoiceRoomFiles({
        async open(documentId) {
          const page = await queryClient
            .fetchQuery(roomDocumentsQueryOptions(client, tenantId, roomId))
            .catch(() => undefined);
          const document = page?.items.find((item) => item.id === documentId);
          if (!document) return false;
          openDocument({
            documentId,
            name: document.title,
            updatedAt: document.updated_at,
          });
          return true;
        },
      }),
    [client, openDocument, queryClient, roomId, tenantId],
  );
  const messagesQuery = roomMessagesInfiniteQueryOptions(
    client,
    tenantId,
    roomId,
  );
  const messages = useSuspenseInfiniteQuery(messagesQuery);
  const { data: room } = useSuspenseQuery(
    roomQueryOptions(client, tenantId, roomId),
  );
  const linkedInTimeline = messages.data.pages.some((page) =>
    page.items.some((message) => message.id === linkedMessageId),
  );
  const linkedMessage = useQuery({
    ...roomMessageQueryOptions(client, tenantId, roomId, linkedMessageId ?? ""),
    enabled: Boolean(linkedMessageId) && !linkedInTimeline,
    retry: false,
  });
  const { data: members } = useSuspenseQuery(
    roomMembersQueryOptions(client, tenantId, roomId),
  );
  const { data: identity } = useSuspenseQuery(
    teamHubIdentityQueryOptions(client),
  );
  const roomDocuments = useQuery({
    ...roomDocumentsQueryOptions(client, tenantId, roomId),
    retry: false,
  });
  const [draftDocumentIds] = useState(() =>
    readRoomComposerDraft({
      accountId: identity.account.id,
      roomId,
      tenantId,
    }).documentReferences.map((reference) => reference.documentId),
  );
  const {
    documents: composerDocuments,
    documentsPending,
    onDocumentQueryChange,
    shareableDocuments,
  } = useComposerDocumentOptions({
    client,
    draftDocumentIds,
    roomDocuments: roomDocuments.data?.items ?? EMPTY_ROOM_DOCUMENTS,
    tenantId,
  });
  const skillManifests = useQuery({
    queryFn: () =>
      loadAllManifestPages((page) =>
        teamHubData(
          client.api.GET("/v0/tenants/{tenantId}/skill-manifests", {
            params: { path: { tenantId }, query: page },
          }),
        ),
      ),
    queryKey: ["teamhub", tenantId, "skill-manifests"],
    staleTime: 60_000,
  });
  const { data: tenantActors } = useQuery(
    tenantActorsQueryOptions(client, tenantId),
  );
  const actorItems = tenantActors?.items ?? EMPTY_TENANT_ACTORS;
  return {
    actorItems,
    client,
    composerDocuments,
    composition,
    documentsPending,
    forwardMessage,
    identity,
    lastAppliedRoomSeq,
    linkedInTimeline,
    linkedMessage,
    linkedMessageId,
    members,
    messages,
    messagesQuery,
    navigate,
    navigation,
    onDocumentQueryChange,
    openPanelTab,
    prefetchPanel,
    queryClient,
    recordMessagePresentation,
    room,
    roomDocuments,
    roomId,
    roomMessagePresentations,
    setForwardMessage,
    shareableDocuments,
    skillManifests,
    tenantId,
  };
}

export type RoomChatData = ReturnType<typeof useRoomChatData>;
