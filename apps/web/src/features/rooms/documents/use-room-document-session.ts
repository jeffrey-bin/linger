/* oxlint-disable react-doctor/query-mutation-missing-invalidation -- Credential issuance returns ephemeral session input and does not mutate a cacheable resource. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import {
  TeamHubError,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import type {
  TeamHubDocument,
  TeamHubDocumentOpenResult,
} from "@/features/teamhub/teamhub-types";
import {
  documentQueryKey,
  roomDocumentQueryKey,
  teamHubIdentityQueryOptions,
} from "../room-queries";

import { artifactPreviewCache } from "../files/artifact-preview-cache";
import type { RoomDocumentCollaborationSession } from "./room-document-collaboration";
import { deleteRoomDocumentLocalCopies } from "./room-document-local-copies";
import { collaborationColor } from "./room-document-presence-model";
import { preloadDocumentEditor } from "./document-editor-preload";

export function useRoomDocumentSession({
  client,
  documentId,
  documentRuntimeUrl,
  roomId,
  tenantId,
}: {
  client: TeamHubClient;
  documentId: string | undefined;
  documentRuntimeUrl: string | undefined;
  roomId?: string;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  const [session, setSession] =
    useState<RoomDocumentCollaborationSession | null>(null);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const resyncSession = useCallback(
    () => setSessionGeneration((generation) => generation + 1),
    [],
  );
  const queryKey =
    roomId === undefined
      ? documentQueryKey(tenantId, documentId ?? "")
      : roomDocumentQueryKey(tenantId, roomId, documentId ?? "");
  function validateDocument(document: TeamHubDocument) {
    if (
      document.id !== documentId ||
      document.tenant_id !== tenantId ||
      (roomId !== undefined &&
        !document.from.some(
          (source) =>
            source.binding_kind === "room" && source.context_id === roomId,
        ))
    ) {
      throw new TeamHubError({
        code: "RESOURCE_NOT_FOUND",
        message: "The requested TeamHub resource is unavailable.",
        status: 404,
      });
    }
    return document;
  }
  // Keep in-flight input local to this viewer. Effect replay can reattach its
  // mutation observer without issuing another HTTP request or sharing a token.
  const openingRequestRef = useRef<
    | {
        key: string;
        request: Promise<TeamHubDocumentOpenResult & { generation: number }>;
      }
    | undefined
  >(undefined);
  // Session tokens belong to this mounted viewer, never to the shared query cache.
  const opening = useMutation({
    mutationFn: (input: { documentId: string; generation: number }) => {
      const key = JSON.stringify([
        tenantId,
        roomId,
        input.documentId,
        input.generation,
      ]);
      if (openingRequestRef.current?.key === key)
        return openingRequestRef.current.request;
      const request = (async () => {
        const result = await teamHubData(
          client.api.POST("/v0/documents/{documentId}/open", {
            params: { path: { documentId: input.documentId } },
          }),
        ).catch(async (error: unknown) => {
          // Bytes prefetched on click must not outlive a denied open.
          if (
            error instanceof TeamHubError &&
            [401, 403, 404].includes(error.status)
          )
            artifactPreviewCache.clear();
          // Access was lost while no editor had the Document open: its local
          // copies can no longer be saved, so drop them before reporting it.
          if (
            error instanceof TeamHubError &&
            [403, 404].includes(error.status)
          )
            await deleteLocalCopiesOfDocument(input.documentId).catch(
              () => undefined,
            );
          throw error;
        });
        validateDocument(result.document);
        queryClient.setQueryData(queryKey, result.document);
        return { ...result, generation: input.generation };
      })();
      openingRequestRef.current = { key, request };
      return request;
    },
    mutationKey: ["teamhub", "document", documentId, "open"],
  });
  async function deleteLocalCopiesOfDocument(id: string) {
    const identity = await queryClient.ensureQueryData(
      teamHubIdentityQueryOptions(client),
    );
    const actor = identity.actors.find(
      (candidate) => candidate.tenant_id === tenantId,
    );
    if (actor !== undefined)
      await deleteRoomDocumentLocalCopies({
        actorIds: [actor.id],
        documentId: id,
      });
  }
  const opened =
    opening.data?.generation === sessionGeneration &&
    opening.data.document.id === documentId &&
    opening.data.document.tenant_id === tenantId
      ? opening.data
      : undefined;
  const documentQuery = useQuery({
    enabled: opened !== undefined,
    queryFn: async () =>
      validateDocument(
        await teamHubData(
          client.api.GET("/v0/documents/{documentId}", {
            params: { path: { documentId: documentId ?? "" } },
          }),
        ),
      ),
    queryKey,
    staleTime: 10_000,
  });
  const identityQuery = useQuery({
    ...teamHubIdentityQueryOptions(client),
    enabled: documentId !== undefined,
  });
  const [openError, setOpenError] = useState<unknown>();
  const sessionRef = useRef<RoomDocumentCollaborationSession | null>(null);
  const runtimeClientRef = useRef(client);
  const document =
    opened === undefined ? undefined : (documentQuery.data ?? opened.document);
  const collaborationCredential = opened?.collaboration_credential;
  const credentialReadOnly =
    opened === undefined
      ? undefined
      : opened.document.draft_capability === "read";
  const credentialGeneration = opened?.generation;
  const actor = identityQuery.data?.actors.find(
    (candidate) => candidate.tenant_id === document?.tenant_id,
  );
  const actorDisplayName = actor?.display_name;
  const actorId = actor?.id;
  const credentialDocumentId = collaborationCredential?.document_id;
  const credentialExpiresAt = collaborationCredential?.expires_at;
  const credentialValue = collaborationCredential?.collaboration_credential;
  const activeDocumentId = document?.id;
  const documentMatchesExpectedRoom =
    roomId === undefined ||
    document?.from.some(
      (source) =>
        source.binding_kind === "room" && source.context_id === roomId,
    ) === true;
  const documentSchemaVersion =
    document?.format === "blocknote" &&
    document.representation_format !== "html"
      ? 1
      : undefined;
  const documentStateHashVersion =
    document?.format === "blocknote" &&
    document.representation_format !== "html"
      ? 1
      : undefined;
  const documentStatus = document?.status;
  const documentTenantId = document?.tenant_id;
  const openDocument = opening.mutate;
  const resetOpening = opening.reset;

  useLayoutEffect(() => {
    runtimeClientRef.current = client;
  }, [client]);

  /* oxlint-disable react-doctor/no-pass-data-to-parent, react-doctor/no-pass-live-state-to-parent -- This effect issues an ephemeral TeamHub credential through a TanStack mutation; it does not pass state to a parent callback. */
  useEffect(() => {
    if (documentId === undefined) return;
    resetOpening();
    openDocument({ documentId, generation: sessionGeneration });
  }, [
    openDocument,
    resetOpening,
    documentId,
    tenantId,
    roomId,
    sessionGeneration,
  ]);
  useEffect(() => {
    if (
      opened !== undefined &&
      document?.draft_capability !== opened.document.draft_capability
    )
      resyncSession();
  }, [document?.draft_capability, opened, resyncSession]);
  /* oxlint-enable react-doctor/no-pass-data-to-parent, react-doctor/no-pass-live-state-to-parent */

  useEffect(() => {
    if (
      credentialGeneration !== sessionGeneration ||
      activeDocumentId === undefined ||
      actorDisplayName === undefined ||
      actorId === undefined ||
      credentialDocumentId === undefined ||
      credentialExpiresAt === undefined ||
      credentialValue === undefined ||
      credentialReadOnly === undefined ||
      documentSchemaVersion === undefined ||
      documentStateHashVersion === undefined ||
      documentStatus === undefined ||
      documentTenantId === undefined
    ) {
      return;
    }
    if (documentRuntimeUrl === undefined) return;

    let active = true;
    let opened: RoomDocumentCollaborationSession | undefined;
    setOpenError(undefined);
    void (async () => {
      validateOpenInputs({
        credentialDocumentId,
        credentialExpiresAt,
        documentId: activeDocumentId,
        documentMatchesExpectedRoom,
        documentStatus,
        documentTenantId,
        expectedDocumentId: documentId,
        expectedRoomId: roomId,
        expectedTenantId: tenantId,
      });
      const user = {
        actorId,
        color: collaborationColor(actorId),
        name: actorDisplayName,
      };
      void preloadDocumentEditor().catch(() => undefined);
      const { openRoomDocumentSession } =
        await import("./room-document-collaboration");
      if (!active) return;
      opened = await openRoomDocumentSession({
        actorId,
        collaborationCredential: credentialValue,
        documentId: activeDocumentId,
        onLocalCopiesDeleted: resyncSession,
        readOnly: credentialReadOnly,
        refreshCredential: async () => {
          const refreshed = await (
            credentialReadOnly
              ? teamHubData(
                  runtimeClientRef.current.api.POST(
                    "/v0/documents/{documentId}/read-session-credentials",
                    { params: { path: { documentId: activeDocumentId } } },
                  ),
                )
              : teamHubData(
                  runtimeClientRef.current.api.POST(
                    "/v0/documents/{documentId}/collaboration-credentials",
                    { params: { path: { documentId: activeDocumentId } } },
                  ),
                )
          ).catch((error: unknown) => {
            // Access was revoked while open: deleting the Document's local
            // copies closes this session, which then reopens to show what
            // is left.
            if (
              error instanceof TeamHubError &&
              [403, 404].includes(error.status)
            )
              void deleteRoomDocumentLocalCopies({
                actorIds: [actorId],
                documentId: activeDocumentId,
              });
            throw error;
          });
          validateRefreshedCredential({
            documentId: refreshed.document_id,
            expectedDocumentId: activeDocumentId,
            expiresAt: refreshed.expires_at,
          });
          return refreshed.collaboration_credential;
        },
        runtimeUrl: documentRuntimeUrl,
        schemaVersion: documentSchemaVersion,
        stateHashVersion: documentStateHashVersion,
        user,
      });
      if (!active) {
        await opened.destroy();
        return;
      }
      sessionRef.current = opened;
      setSession(opened);
    })().catch((error: unknown) => {
      if (active) setOpenError(error);
    });

    return () => {
      active = false;
      const current = opened;
      sessionRef.current = null;
      setSession(null);
      if (current !== undefined) void current.destroy();
    };
  }, [
    activeDocumentId,
    actorDisplayName,
    actorId,
    credentialDocumentId,
    credentialGeneration,
    credentialExpiresAt,
    credentialReadOnly,
    credentialValue,
    documentId,
    documentRuntimeUrl,
    documentMatchesExpectedRoom,
    documentSchemaVersion,
    documentStateHashVersion,
    documentStatus,
    documentTenantId,
    roomId,
    sessionGeneration,
    resyncSession,
    tenantId,
  ]);

  function closeSession() {
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    if (current !== null) void current.destroy();
  }

  return {
    closeSession,
    currentIdentity: identityQuery.data,
    currentVersion: opened?.current_version,
    document,
    error:
      documentId === undefined
        ? "Document metadata is unavailable."
        : collaborationErrorMessage(
            documentQuery.error ??
              identityQuery.error ??
              opening.error ??
              openError,
          ),
    session,
    resyncSession,
  };
}

function validateRefreshedCredential(input: {
  documentId: string;
  expectedDocumentId: string;
  expiresAt: string;
}): void {
  if (
    input.documentId !== input.expectedDocumentId ||
    !credentialExpiryIsValid(input.expiresAt)
  ) {
    throw new Error("TeamHub returned inconsistent Document session metadata.");
  }
}

function collaborationErrorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (
    error instanceof TeamHubError &&
    error.status === 404 &&
    error.code === "NOT_FOUND"
  ) {
    return "Document is unavailable.";
  }
  return error instanceof Error
    ? error.message
    : "Document collaboration could not be opened.";
}

function validateOpenInputs(input: {
  credentialDocumentId: string;
  credentialExpiresAt: string;
  documentId: string;
  documentMatchesExpectedRoom: boolean;
  documentStatus: TeamHubDocument["status"];
  documentTenantId: string;
  expectedDocumentId: string | undefined;
  expectedRoomId: string | undefined;
  expectedTenantId: string;
}): void {
  if (input.documentStatus !== "active") {
    throw new Error("Document is unavailable.");
  }
  if (
    input.documentId !== input.expectedDocumentId ||
    input.documentTenantId !== input.expectedTenantId ||
    (input.expectedRoomId !== undefined &&
      !input.documentMatchesExpectedRoom) ||
    input.credentialDocumentId !== input.documentId ||
    !credentialExpiryIsValid(input.credentialExpiresAt)
  ) {
    throw new Error("TeamHub returned inconsistent Document session metadata.");
  }
}

function credentialExpiryIsValid(value: string): boolean {
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}
