import { QueryClient } from "@tanstack/react-query";

import { TeamHubError } from "@/features/teamhub/teamhub-client";

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: {
        networkMode: "always",
      },
      queries: {
        networkMode: "always",
        // Retry once, but not after 401 or a search TeamHub stopped at its
        // time limit, which would only time out again.
        retry: (failureCount, error) =>
          !(
            error instanceof TeamHubError &&
            (error.status === 401 || error.code === "SEARCH_TIMEOUT")
          ) && failureCount < 1,
      },
    },
  });
}
