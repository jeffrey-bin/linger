import { useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useNavigate } from "react-router";

import { registerVoiceSearch } from "@/features/rooms/chat/voice-mode/voice-ui-bridge";
import { tenantRoomsQueryKey } from "@/features/rooms/room-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

import {
  HIGHLIGHT_MAX_LENGTH,
  QUERY_RECORD_DELAY_MS,
  resultTarget,
  roomChatPath,
  voiceResultName,
  type GlobalSearchTab,
  type SearchResult,
  type TargetContext,
} from "./global-search-model";
import {
  recordGlobalSearchQuery,
  type GlobalSearchStore,
  type SearchTarget,
} from "./global-search-recent";

type SetStore = Dispatch<SetStateAction<GlobalSearchStore>>;

/** Opens a row: reruns a recent query, enters a scope, or navigates to a hit. */
export function useOpenResult({
  client,
  debouncedRaw,
  directRoomIdByPeer,
  enterScope,
  onClose,
  query,
  runQuery,
  setStore,
  targetContext,
  tenantId,
}: {
  client: TeamHubClient;
  debouncedRaw: string;
  directRoomIdByPeer: Map<string, string>;
  enterScope: (next: GlobalSearchTab) => void;
  onClose: () => void;
  query: string;
  runQuery: (text: string) => void;
  setStore: SetStore;
  targetContext: TargetContext;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [openError, setOpenError] = useState<string | null>(null);
  const openingRef = useRef(false);

  /**
   * Where an Agent's row leads: the Direct Room with that Agent, created on
   * first open when it does not exist yet.
   */
  async function conversationPath(target: SearchTarget) {
    if (target.kind !== "agent") return target.path;
    const known = directRoomIdByPeer.get(target.id);
    if (known) return roomChatPath(tenantId, known);
    const { id: roomId } = await teamHubData(
      client.api.POST("/v0/tenants/{tenantId}/direct-rooms", {
        params: { path: { tenantId } },
        body: { peer_actor_id: target.id },
      }),
    );
    await queryClient.invalidateQueries({
      queryKey: tenantRoomsQueryKey(tenantId),
    });
    return roomChatPath(tenantId, roomId);
  }

  async function openResult(result: SearchResult) {
    if (result.kind === "query") {
      runQuery(result.text);
      return;
    }
    if (result.kind === "scope") {
      enterScope(result.tab);
      return;
    }
    if (openingRef.current) return;
    openingRef.current = true;
    setOpenError(null);
    try {
      const target = resultTarget(result, targetContext);
      const destination = await conversationPath(target);
      if (!destination) {
        setOpenError("This conversation could not be opened.");
        return;
      }
      const keyword = query.trim().slice(0, HIGHLIGHT_MAX_LENGTH);
      // Ordinary Room messages carry the keyword so the timeline can highlight it.
      const path =
        result.kind === "message" &&
        result.hit.room.kind !== "thread" &&
        keyword
          ? `${destination}&highlight=${encodeURIComponent(keyword)}`
          : destination;
      if (debouncedRaw)
        setStore(recordGlobalSearchQuery(tenantId, debouncedRaw));
      onClose();
      void navigate(path);
    } catch (cause) {
      setOpenError(
        cause instanceof Error && cause.message
          ? cause.message
          : "The conversation could not be opened.",
      );
    } finally {
      openingRef.current = false;
    }
  }

  return { openError, openResult };
}

/**
 * A query that stayed on screen with results counts as a search the person
 * ran; intermediate keystrokes fall out before the delay elapses.
 */
export function useRecordRecentQuery({
  debouncedRaw,
  hasResults,
  pending,
  setStore,
  tenantId,
}: {
  debouncedRaw: string;
  hasResults: boolean;
  pending: boolean;
  setStore: SetStore;
  tenantId: string;
}) {
  useEffect(() => {
    if (!debouncedRaw || pending || !hasResults) return;
    const timer = window.setTimeout(
      () => setStore(recordGlobalSearchQuery(tenantId, debouncedRaw)),
      QUERY_RECORD_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [debouncedRaw, hasResults, pending, setStore, tenantId]);
}

/** Live voice reads the visible results and opens them like a click. */
export function useVoiceSearchBridge({
  onClose,
  openResult,
  rows,
  setQuery,
  setTab,
  targetContext,
}: {
  onClose: () => void;
  openResult: (result: SearchResult) => Promise<void>;
  rows: SearchResult[];
  setQuery: Dispatch<SetStateAction<string>>;
  setTab: Dispatch<SetStateAction<GlobalSearchTab>>;
  targetContext: TargetContext;
}) {
  const voiceRef = useRef({ openResult, rows, targetContext });
  useLayoutEffect(() => {
    voiceRef.current = { openResult, rows, targetContext };
  });
  useEffect(
    () =>
      registerVoiceSearch({
        close: onClose,
        open: async (id) => {
          const row = voiceRef.current.rows.find((item) => item.id === id);
          if (row) await voiceRef.current.openResult(row);
        },
        results: () =>
          voiceRef.current.rows.flatMap((row) =>
            row.kind === "query" || row.kind === "scope"
              ? []
              : [
                  {
                    id: row.id,
                    name: voiceResultName(
                      resultTarget(row, voiceRef.current.targetContext),
                    ),
                  },
                ],
          ),
        search: (text) => {
          setTab("all");
          setQuery(text);
        },
      }),
    [onClose, setQuery, setTab],
  );
}
