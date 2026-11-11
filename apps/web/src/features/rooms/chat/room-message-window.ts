import type {
  InfiniteData,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";
import { useEffect } from "react";

/**
 * Messages a Room timeline keeps loaded while the reader follows the newest
 * Message. A tab left open in a busy Room would otherwise keep every Message
 * it ever loaded or received, with its DOM, decoded images and HTML fragments.
 * Dropped history loads again through "load older" when the reader scrolls up.
 */
export const ROOM_MESSAGE_RETAINED_LIMIT = 200;

type MessagePages<TPage extends { items: readonly unknown[] }> = InfiniteData<
  TPage,
  unknown
>;

export type RoomMessageWindowTrim<TPage extends { items: readonly unknown[] }> =
  | { kind: "none" }
  /** Keep the newest pages; the last kept page's cursor still continues them. */
  | { kind: "drop-older-pages"; data: MessagePages<TPage> }
  /**
   * The newest page alone outgrew the limit through live appends. Its cursor
   * points before its oldest item, so dropping items would leave a gap; keep
   * only that page and refetch it so TeamHub issues a cursor for the newest
   * page. Live Messages newer than the response survive the refetch merge.
   */
  | { kind: "refetch-newest"; data: MessagePages<TPage> };

/** Plans how to bring loaded Room history back within `limit` Messages. */
export function planRoomMessageWindowTrim<
  TPage extends { items: readonly unknown[] },
>(
  data: MessagePages<TPage>,
  limit = ROOM_MESSAGE_RETAINED_LIMIT,
): RoomMessageWindowTrim<TPage> {
  const total = data.pages.reduce((sum, page) => sum + page.items.length, 0);
  if (total <= limit || data.pages.length === 0) return { kind: "none" };
  let kept = 0;
  let count = 0;
  for (const page of data.pages) {
    if (kept > 0 && count + page.items.length > limit) break;
    count += page.items.length;
    kept += 1;
  }
  const trimmed = {
    pages: data.pages.slice(0, kept),
    pageParams: data.pageParams.slice(0, kept),
  };
  return count <= limit
    ? { kind: "drop-older-pages", data: trimmed }
    : { kind: "refetch-newest", data: trimmed };
}

/**
 * Applies {@link planRoomMessageWindowTrim} after the loaded Message count
 * changes, when no page is loading, the last read did not fail, and `canTrim`
 * allows it. `canTrim` is read only on a count change, so it must read live
 * state (refs, DOM) rather than values captured by an earlier render.
 */
export function useRoomMessageWindowTrim({
  canTrim,
  messageCount,
  queryClient,
  queryKey,
}: {
  canTrim: () => boolean;
  messageCount: number;
  queryClient: QueryClient;
  queryKey: QueryKey;
}) {
  const queryHash = JSON.stringify(queryKey);
  useEffect(() => {
    if (messageCount <= ROOM_MESSAGE_RETAINED_LIMIT) return;
    const state = queryClient.getQueryState(queryKey);
    if (state?.fetchStatus !== "idle" || state.status === "error") return;
    if (!canTrim()) return;
    const data =
      queryClient.getQueryData<MessagePages<{ items: readonly unknown[] }>>(
        queryKey,
      );
    if (!data) return;
    const plan = planRoomMessageWindowTrim(data);
    if (plan.kind === "none") return;
    queryClient.setQueryData(queryKey, plan.data);
    if (plan.kind === "refetch-newest") {
      void queryClient.refetchQueries({ exact: true, queryKey });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is compared by value and canTrim reads refs
  }, [messageCount, queryClient, queryHash]);
}
