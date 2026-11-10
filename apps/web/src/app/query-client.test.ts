import { onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubError } from "@/features/teamhub/teamhub-client";

import { createAppQueryClient } from "./query-client";

describe("App QueryClient connectivity policy", () => {
  afterEach(() => onlineManager.setOnline(true));

  it("attempts a query when the browser connectivity manager reports offline", async () => {
    const queryClient = createAppQueryClient();
    const queryFn = vi.fn().mockResolvedValue("available");
    onlineManager.setOnline(false);
    void queryClient
      .fetchQuery({
        queryFn,
        queryKey: ["connectivity-probe"],
      })
      .catch(() => undefined);

    try {
      await vi.waitFor(() => expect(queryFn).toHaveBeenCalledOnce(), {
        timeout: 250,
      });
    } finally {
      await queryClient.cancelQueries();
      queryClient.clear();
      onlineManager.setOnline(true);
    }
  });

  it("does not retry a search TeamHub stopped at its time limit", async () => {
    const queryClient = createAppQueryClient();
    const timeout = new TeamHubError({
      code: "SEARCH_TIMEOUT",
      message: "search took too long",
      status: 503,
    });
    const queryFn = vi.fn().mockRejectedValue(timeout);

    await expect(
      queryClient.fetchQuery({ queryFn, queryKey: ["search-timeout-probe"] }),
    ).rejects.toBe(timeout);
    expect(queryFn).toHaveBeenCalledOnce();
    queryClient.clear();
  });
});
