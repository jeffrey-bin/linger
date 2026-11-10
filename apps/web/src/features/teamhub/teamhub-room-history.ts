import type { components } from "@linger/wire-contracts/teamhub-public/types";
import {
  teamHubData as data,
  teamHubDone as done,
  type TeamHubApi,
} from "./teamhub-api";

export type RoomHistoryShare = components["schemas"]["RoomHistoryShare"];
export type RoomHistorySnapshot = components["schemas"]["RoomHistorySnapshot"];
export type RoomHistoryMessage = components["schemas"]["RoomHistoryMessage"];
export interface TeamHubRoomHistory {
  list(roomId: string): Promise<{ items: RoomHistoryShare[] }>;
  create(roomId: string): Promise<RoomHistoryShare>;
  link(roomId: string, shareId: string): Promise<RoomHistoryShare>;
  revoke(roomId: string, shareId: string): Promise<void>;
  read(
    token: string,
    after: number,
    signal?: AbortSignal,
  ): Promise<RoomHistorySnapshot>;
  image(token: string, assetId: string, signal?: AbortSignal): Promise<Blob>;
}
export function createTeamHubRoomHistory(api: TeamHubApi): TeamHubRoomHistory {
  // Reading a shared history is anonymous: no cookie, no redirect, no cache.
  const anonymous = {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  } as const;
  return {
    list: (roomId) =>
      data(
        api.GET("/v0/rooms/{roomId}/history-shares", {
          params: { path: { roomId } },
          cache: "no-store",
        }),
      ),
    create: (roomId) =>
      data(
        api.POST("/v0/rooms/{roomId}/history-shares/create", {
          params: { path: { roomId } },
          body: {
            web_version:
              document
                .querySelector('script[type="module"][src]')
                ?.getAttribute("src") ?? "development",
          },
          cache: "no-store",
          referrerPolicy: "no-referrer",
        }),
      ),
    link: (roomId, shareId) =>
      data(
        api.POST("/v0/rooms/{roomId}/history-shares/{shareId}/link", {
          params: { path: { roomId, shareId } },
          cache: "no-store",
        }),
      ),
    revoke: (roomId, shareId) =>
      done(
        api.DELETE("/v0/rooms/{roomId}/history-shares/{shareId}", {
          params: { path: { roomId, shareId } },
        }),
      ),
    read: (token, after, signal) =>
      data(
        api.POST("/v0/shared-room-history/read", {
          body: { token, after },
          signal,
          ...anonymous,
        }),
      ),
    image: (token, assetId, signal) =>
      data(
        api.POST("/v0/shared-room-history/asset", {
          body: { token, asset_id: assetId },
          parseAs: "blob",
          signal,
          ...anonymous,
        }),
      ),
  };
}
