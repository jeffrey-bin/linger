import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { roomMessagesQueryKey } from "@/features/rooms/room-queries";
import { createTeamHubTestSeed } from "@/test/teamhub-seed";
import type {
  TeamHubMessage,
  TeamHubMessagePage,
} from "@/features/teamhub/teamhub-types";

import { replaceLoadedRoomMessage } from "./room-projection";

describe("loaded Room Message replacement", () => {
  it("does not replace a newer card with an older idempotent response", () => {
    const queryClient = new QueryClient();
    const queryKey = roomMessagesQueryKey(
      "tenant-northstar",
      "room-product-v0",
    );
    const fixture = createTeamHubTestSeed();
    const source = fixture.messagesByRoom
      .get("room-product-v0")
      ?.find((message) => message.id === "message-card-room-creation");
    if (!source?.card) throw new Error("Typed card fixture is unavailable");
    const newer = withCardVersion(source, 4);
    const staleReplay = withCardVersion(source, 3);
    queryClient.setQueryData(queryKey, {
      pageParams: [undefined],
      pages: [{ items: [newer], page: { has_more: false } }],
    });

    replaceLoadedRoomMessage(
      queryClient,
      "tenant-northstar",
      "room-product-v0",
      staleReplay,
    );

    const cached = queryClient.getQueryData<{
      pages: TeamHubMessagePage[];
    }>(queryKey);
    expect(cached?.pages[0]?.items).toEqual([newer]);
  });
});

function withCardVersion(
  message: TeamHubMessage,
  version: number,
): TeamHubMessage {
  if (!message.card) throw new Error("Typed card fixture is unavailable");
  return { ...message, card: { ...message.card, version } };
}
