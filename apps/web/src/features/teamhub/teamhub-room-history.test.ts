import { sentRequests } from "./teamhub-client-test-support";
import { describe, expect, it, vi } from "vitest";
import { createHttpTeamHubClient } from "./teamhub-client";
import { requestUrlText } from "@linger/service-kit";

describe("Room history anonymous transport", () => {
  it("posts secrets in the body, omits session cookies and calls fetch without a receiver", async () => {
    const fetchRequest = vi.fn(function (
      this: unknown,
      input: RequestInfo | URL,
    ) {
      expect(this).toBeUndefined();
      if (!(input instanceof Request)) throw new Error("Expected a Request");
      if (input.url.includes("shared-room-history"))
        expect(input.credentials).toBe("omit");
      expect(input.cache).toBe("no-store");
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], next_after: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    const client = createHttpTeamHubClient({
      baseUrl: "https://web.example/",
      fetchRequest,
    });
    await client.roomHistory.read("private-token", 50);
    await client.roomHistory.image("private-token", "image-1");
    await client.roomHistory.link("room-1", "share-1");
    expect(
      (await sentRequests(fetchRequest)).map(([url]) => requestUrlText(url)),
    ).toEqual([
      "https://web.example/v0/shared-room-history/read",
      "https://web.example/v0/shared-room-history/asset",
      "https://web.example/v0/rooms/room-1/history-shares/share-1/link",
    ]);
    expect((await sentRequests(fetchRequest))[0]?.[1]?.body).toBe(
      JSON.stringify({ token: "private-token", after: 50 }),
    );
    expect((await sentRequests(fetchRequest))[1]?.[1]?.body).toBe(
      JSON.stringify({ token: "private-token", asset_id: "image-1" }),
    );
  });
});
