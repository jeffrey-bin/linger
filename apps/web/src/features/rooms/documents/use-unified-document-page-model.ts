import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { useWorkspaceTree } from "@/features/library/workspace-tree";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { requireRoomRouteParam } from "../room-route-params";

import type {
  RoomDocumentEditor,
  RoomDocumentHeading,
} from "./room-document-blocknote-editor";
import { useRoomDocumentSession } from "./use-room-document-session";
import { useUnifiedDocumentActions } from "./use-unified-document-actions";

export type UnifiedDocumentPageModel = ReturnType<
  typeof useUnifiedDocumentPageModel
>;

export function useUnifiedDocumentPageModel(sidebar?: {
  documentId: string;
  tenantId: string;
}) {
  const route = useUnifiedDocumentRoute(sidebar);
  const { client, documentId, queryClient, tenantId } = route;
  const panels = useUnifiedDocumentPanels();
  const editorRef = useRef<RoomDocumentEditor | null>(null);
  const data = useUnifiedDocumentData({
    client,
    documentId,
    documentRuntimeUrl: route.documentRuntimeUrl,
    tenantId,
  });
  const { document, session } = data;
  const actions = useUnifiedDocumentActions({
    client,
    closeSession: data.closeSession,
    document,
    navigate: route.navigate,
    queryClient,
    tenantId,
  });
  const isWikiPage =
    document?.from.some((source) => source.binding_kind === "wiki_page") ===
    true;
  // A sent mail canvas is final: editing it no longer changes what went out.
  const [sentCanvasDocumentId, setSentCanvasDocumentId] = useState<string>();
  const canvasSent = sentCanvasDocumentId === documentId;
  const onCanvasSentChange = useCallback(
    (sent: boolean) => setSentCanvasDocumentId(sent ? documentId : undefined),
    [documentId],
  );
  const isEditing =
    !isWikiPage && !canvasSent && (panels.editingOverride ?? true);

  return {
    sidebar: Boolean(sidebar),
    actor: data.actor,
    autoFocusTitle: route.autoFocusTitle,
    canvasSent,
    client,
    commentsOpen: panels.commentsOpen,
    commentsPortalTarget: panels.commentsPortalTarget,
    consumeAutoFocusTitle: route.consumeAutoFocusTitle,
    currentVersion: data.currentVersion,
    document,
    documentActionError: actions.documentActionError,
    documentId,
    duplicateDocument: actions.duplicateDocument,
    duplicatePending: actions.duplicatePending,
    editorRef,
    error: data.error,
    exportDocument: actions.exportDocument,
    exportError: actions.exportError,
    exportPending: actions.exportPending,
    headings: panels.headings,
    historyOpen: panels.historyOpen,
    onCanvasSentChange,
    isEditing: isEditing && !session?.readOnly,
    isSharedDocument: data.isSharedDocument,
    queryClient,
    roomId: data.roomId,
    resyncSession: data.resyncSession,
    session,
    shareOpen: panels.shareOpen,
    sharedTree: data.sharedTree,
    setCommentsOpen: panels.setCommentsOpen,
    setCommentsPortalTarget: panels.setCommentsPortalTarget,
    setHeadings: panels.setHeadings,
    setHistoryOpen: panels.setHistoryOpen,
    setIsEditing: panels.setIsEditing,
    setShareOpen: panels.setShareOpen,
    setTocOpen: panels.setTocOpen,
    setTrashConfirmOpen: actions.setTrashConfirmOpen,
    setTreeOpen: panels.setTreeOpen,
    tenantId,
    tocOpen: panels.tocOpen,
    trashConfirmOpen: actions.trashConfirmOpen,
    trashDocument: actions.trashDocument,
    trashError: actions.trashError,
    trashPending: actions.trashPending,
    tree: data.tree,
    treeOpen: panels.treeOpen,
  };
}

/** Resolves the Document identity from the sidebar props or the route. */
function useUnifiedDocumentRoute(
  sidebar: { documentId: string; tenantId: string } | undefined,
) {
  const { client, documentRuntimeUrl } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const tenantId =
    sidebar?.tenantId ?? requireRoomRouteParam(params.tenantId, "Tenant");
  const documentId =
    sidebar?.documentId ?? requireRoomRouteParam(params.documentId, "Document");
  const autoFocusTitle =
    !sidebar &&
    typeof location.state === "object" &&
    location.state !== null &&
    "editDocumentTitle" in location.state &&
    location.state.editDocumentTitle === true &&
    "selectTitleBaseName" in location.state &&
    location.state.selectTitleBaseName === true;
  const consumeAutoFocusTitle = useCallback(() => {
    if (!autoFocusTitle) return;
    void navigate(
      {
        hash: location.hash,
        pathname: location.pathname,
        search: location.search,
      },
      { replace: true, state: null },
    );
  }, [
    autoFocusTitle,
    location.hash,
    location.pathname,
    location.search,
    navigate,
  ]);
  return {
    autoFocusTitle,
    client,
    consumeAutoFocusTitle,
    documentId,
    documentRuntimeUrl,
    navigate,
    queryClient,
    tenantId,
  };
}

/** Open/closed state of the page's side panels, dialogs, and edit mode. */
function useUnifiedDocumentPanels() {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsPortalTarget, setCommentsPortalTarget] =
    useState<HTMLDivElement | null>(null);
  const [headings, setHeadings] = useState<RoomDocumentHeading[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editingOverride, setIsEditing] = useState<boolean>();
  const [shareOpen, setShareOpen] = useState(false);
  const { open: treeOpen, setOpen: setTreeOpen } = useWorkspaceTree();
  const [tocOpen, setTocOpen] = useState(false);
  return {
    commentsOpen,
    commentsPortalTarget,
    editingOverride,
    headings,
    historyOpen,
    setCommentsOpen,
    setCommentsPortalTarget,
    setHeadings,
    setHistoryOpen,
    setIsEditing,
    setShareOpen,
    setTocOpen,
    setTreeOpen,
    shareOpen,
    tocOpen,
    treeOpen,
  };
}

/**
 * Reads the Document, its collaboration session, and the placement trees.
 * The personal tree query runs before the session hook and the shared tree
 * query after it, because the shared tree depends on the session's actor.
 */
function useUnifiedDocumentData({
  client,
  documentId,
  documentRuntimeUrl,
  tenantId,
}: {
  client: TeamHubClient;
  documentId: string;
  documentRuntimeUrl: string | undefined;
  tenantId: string;
}) {
  const tree = useQuery({
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/me/document-tree", {
          params: { path: { tenantId } },
        }),
      ),
    queryKey: ["teamhub", tenantId, "document-tree"],
    staleTime: 60_000,
  });
  const {
    closeSession,
    currentIdentity,
    currentVersion,
    document,
    error,
    resyncSession,
    session,
  } = useRoomDocumentSession({
    client,
    documentId,
    documentRuntimeUrl,
    tenantId,
  });
  const actor = currentIdentity?.actors.find(
    (candidate) => candidate.tenant_id === document?.tenant_id,
  );
  const isSharedDocument =
    document !== undefined &&
    actor !== undefined &&
    document.owner.id !== actor.id;
  const sharedTree = useQuery({
    enabled: isSharedDocument,
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/me/shared-document-tree", {
          params: { path: { tenantId } },
        }),
      ),
    queryKey: ["teamhub", tenantId, "shared-document-tree"],
    staleTime: 60_000,
  });
  const roomId = document?.from.find(
    (source) => source.binding_kind === "room",
  )?.context_id;
  return {
    actor,
    closeSession,
    currentVersion,
    document,
    error,
    isSharedDocument,
    resyncSession,
    roomId,
    session,
    sharedTree,
    tree,
  };
}
