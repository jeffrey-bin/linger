import { queryOptions } from "@tanstack/react-query";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubRuntimePresentationEventPage } from "@/features/teamhub/teamhub-types";
import { roomRuntimePresentationEventsQueryKey } from "../room-queries";

export function roomRuntimePresentationEventsQueryOptions(
  client: Pick<TeamHubClient, "api">,
  tenantId: string,
  roomId: string,
  runStatusId: string,
) {
  return queryOptions({
    queryFn: ({ signal }) =>
      collectRuntimePresentationEvents(
        client,
        roomId,
        runStatusId,
        undefined,
        signal,
      ),
    queryKey: roomRuntimePresentationEventsQueryKey(
      tenantId,
      roomId,
      runStatusId,
    ),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export async function collectRuntimePresentationEvents(
  client: Pick<TeamHubClient, "api">,
  roomId: string,
  runStatusId: string,
  previous?: TeamHubRuntimePresentationEventPage,
  signal?: AbortSignal,
): Promise<TeamHubRuntimePresentationEventPage> {
  const items: TeamHubRuntimePresentationEventPage["items"] = [
    ...(previous?.items ?? []),
  ];
  let after = previous?.published_through_ordinal ?? "0";
  const previousLast = items.at(-1)?.event_ordinal ?? "0";
  if (BigInt(previousLast) !== BigInt(after)) {
    throw new Error(
      "Cached Runtime presentation event sequence does not match its published watermark.",
    );
  }

  for (;;) {
    const page = await teamHubData(
      client.api.GET(
        "/v0/rooms/{roomId}/runs/{runId}/runtime-presentation-events",
        {
          params: {
            path: { roomId, runId: runStatusId },
            query: { after, limit: 200 },
          },
          signal,
        },
      ),
    );
    let expected = BigInt(after) + 1n;
    for (const record of page.items) {
      const ordinal = BigInt(record.event_ordinal);
      if (ordinal !== expected) {
        throw new Error(
          "Runtime presentation event sequence is not contiguous.",
        );
      }
      expected += 1n;
      items.push(record);
    }

    const last = page.items.at(-1)?.event_ordinal;
    if (!page.has_more) {
      const finalOrdinal = last ?? after;
      if (BigInt(page.published_through_ordinal) !== BigInt(finalOrdinal)) {
        throw new Error(
          "Runtime presentation event page ended before its published watermark.",
        );
      }
      return {
        has_more: false,
        items,
        published_through_ordinal: page.published_through_ordinal,
      };
    }
    if (!last) {
      throw new Error("Runtime presentation event page did not advance.");
    }
    after = last;
  }
}
