import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";

import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubRoomPage } from "@/features/teamhub/teamhub-types";

import { tenantRoomsQueryKey } from "../room-queries";
import { createRoomReadStateAdvancer } from "./room-read-state-advancer";

export function RoomReadStateSync({
  roomId,
  tenantId,
  throughRoomSeq,
}: {
  roomId: string;
  tenantId: string;
  throughRoomSeq: number;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const advancerRef = useRef<ReturnType<
    typeof createRoomReadStateAdvancer
  > | null>(null);

  // Create and dispose in one effect so a StrictMode or Activity remount gets
  // a live advancer instead of a disposed one that silently drops new seqs.
  useLayoutEffect(() => {
    const initialReadThroughRoomSeq =
      queryClient
        .getQueryData<TeamHubRoomPage>(tenantRoomsQueryKey(tenantId))
        ?.items.find((room) => room.id === roomId)?.read_through_room_seq ?? 0;
    const advancer = createRoomReadStateAdvancer({
      client,
      initialReadThroughRoomSeq,
      refreshRoomList: async (readThroughRoomSeq) => {
        const queryKey = tenantRoomsQueryKey(tenantId);
        // Reading through the latest event zeroes the counts exactly, so only
        // a partial read needs a reload for TeamHub to recount the rest.
        let exact = false;
        queryClient.setQueryData<TeamHubRoomPage>(queryKey, (current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            items: current.items.map((room) => {
              if (
                room.id !== roomId ||
                room.read_through_room_seq >= readThroughRoomSeq
              ) {
                return room;
              }
              const coversLatestRoomSeq =
                readThroughRoomSeq >= room.latest_room_seq;
              exact = coversLatestRoomSeq;
              return {
                ...room,
                read_through_room_seq: readThroughRoomSeq,
                unread_mention_count: coversLatestRoomSeq
                  ? 0
                  : room.unread_mention_count,
                unread_message_count: coversLatestRoomSeq
                  ? 0
                  : room.unread_message_count,
              };
            }),
          };
        });
        if (exact) return;
        await queryClient.invalidateQueries({
          exact: true,
          queryKey,
          refetchType: "none",
        });
        await queryClient.refetchQueries(
          { exact: true, queryKey, type: "all" },
          { throwOnError: true },
        );
      },
      roomId,
    });
    advancerRef.current = advancer;
    return () => {
      advancer.dispose();
      advancerRef.current = null;
    };
  }, [client, queryClient, roomId, tenantId]);

  useLayoutEffect(() => {
    advancerRef.current?.advance(throughRoomSeq);
  }, [client, queryClient, roomId, tenantId, throughRoomSeq]);

  return null;
}
