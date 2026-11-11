import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ROOM_MESSAGE_RETAINED_LIMIT,
  planRoomMessageWindowTrim,
  useRoomMessageWindowTrim,
} from "./room-message-window";

function page(from: number, count: number) {
  return {
    items: Array.from({ length: count }, (_, index) => `m${from + index}`),
    page: { has_more: true, next_cursor: `m${from}` },
  };
}

function history(sizes: number[]) {
  // Newest page first, as TeamHub returns them.
  let next = sizes.reduce((sum, size) => sum + size, 0);
  const pages = sizes.map((size) => {
    next -= size;
    return page(next, size);
  });
  return {
    pages,
    pageParams: pages.map((_, index) =>
      index === 0 ? undefined : pages[index - 1]!.page.next_cursor,
    ),
  };
}

describe("planRoomMessageWindowTrim", () => {
  it("keeps history within the limit untouched", () => {
    expect(planRoomMessageWindowTrim(history([50, 50, 50, 50]))).toEqual({
      kind: "none",
    });
  });

  it("drops older pages beyond the limit with their page params", () => {
    const data = history([51, 50, 50, 50, 50]);
    const plan = planRoomMessageWindowTrim(data);

    expect(plan.kind).toBe("drop-older-pages");
    if (plan.kind === "none") return;
    expect(plan.data.pages).toEqual(data.pages.slice(0, 3));
    expect(plan.data.pageParams).toEqual(data.pageParams.slice(0, 3));
    // The last kept page still continues into the dropped history.
    expect(plan.data.pages.at(-1)!.page.next_cursor).toBe(data.pageParams[3]);
  });

  it("refetches the newest page once live appends alone outgrow the limit", () => {
    const data = history([ROOM_MESSAGE_RETAINED_LIMIT + 1, 50]);
    const plan = planRoomMessageWindowTrim(data);

    expect(plan).toEqual({
      kind: "refetch-newest",
      data: { pages: [data.pages[0]], pageParams: [undefined] },
    });
  });
});

describe("useRoomMessageWindowTrim", () => {
  const queryKey = ["teamhub", "t", "room", "r", "messages"];

  function setup(
    sizes: number[],
    canTrim: boolean,
    state: { fetchStatus?: "fetching"; status?: "error" } = {},
  ) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKey, history(sizes));
    queryClient.getQueryCache().find({ queryKey })!.setState(state);
    const refetch = vi
      .spyOn(queryClient, "refetchQueries")
      .mockResolvedValue(undefined);
    renderHook(() =>
      useRoomMessageWindowTrim({
        canTrim: () => canTrim,
        messageCount: sizes.reduce((sum, size) => sum + size, 0),
        queryClient,
        queryKey,
      }),
    );
    return {
      pageCount: () =>
        queryClient.getQueryData<{ pages: unknown[] }>(queryKey)!.pages.length,
      refetch,
    };
  }

  it("keeps everything while the reader is in history or a link is open", () => {
    const { pageCount, refetch } = setup([50, 50, 50, 50, 50], false);
    expect(pageCount()).toBe(5);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("drops older pages while following the newest Message", () => {
    const { pageCount, refetch } = setup([50, 50, 50, 50, 50], true);
    expect(pageCount()).toBe(4);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("refetches an oversized newest page instead of inventing a cursor", () => {
    const { pageCount, refetch } = setup([250, 50], true);
    expect(pageCount()).toBe(1);
    expect(refetch).toHaveBeenCalledWith({ exact: true, queryKey });
  });

  it("waits while an older page loads", () => {
    const { pageCount, refetch } = setup([50, 50, 50, 50, 50], true, {
      fetchStatus: "fetching",
    });
    expect(pageCount()).toBe(5);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("does not refetch after a failed read", () => {
    const { pageCount, refetch } = setup([250, 50], true, { status: "error" });
    expect(pageCount()).toBe(2);
    expect(refetch).not.toHaveBeenCalled();
  });
});
