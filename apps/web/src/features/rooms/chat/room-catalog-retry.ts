import {
  TeamHubError,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-error";

/** Only opt-in catalog reads: never apply this policy to mutations. */
export const roomCatalogRetry = {
  retry: (failureCount: number, error: unknown) =>
    failureCount < 2 &&
    (error instanceof TeamHubTransportError ||
      (error instanceof TeamHubError &&
        [502, 503, 504].includes(error.status) &&
        // A search TeamHub stopped at its time limit would only time out again.
        error.code !== "SEARCH_TIMEOUT")),
  retryDelay: (attemptIndex: number) => 1_000 * 2 ** attemptIndex,
};
