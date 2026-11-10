import type { components } from "@linger/wire-contracts/teamhub-internal/types";

export type TaskProgressSnapshot =
  components["schemas"]["TaskProgressSnapshot"];
export type TaskProgressTask = components["schemas"]["TaskProgressTask"];

/** TeamHub reads how the Tasks a Meta Context coordinates are going. */
export interface TaskProgressClient {
  read(
    roomId: string,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<TaskProgressSnapshot>;
}

export interface TeamHubTaskProgressClientOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetch?: typeof fetch;
}

export function createTeamHubTaskProgressClient(
  options: TeamHubTaskProgressClientOptions,
): TaskProgressClient {
  return {
    async read(roomId, agentId, signal) {
      const response = await (options.fetch ?? fetch)(
        new URL(
          ["v0", "rooms", roomId, "agents", agentId, "task-progress"]
            .map(encodeURIComponent)
            .join("/"),
          options.baseUrl.endsWith("/")
            ? options.baseUrl
            : `${options.baseUrl}/`,
        ),
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.any([
            AbortSignal.timeout(10_000),
            ...(signal ? [signal] : []),
          ]),
          headers: { authorization: `Bearer ${options.serviceToken}` },
        },
      );
      if (!response.ok)
        throw new Error(`TeamHub task progress failed: ${response.status}`);
      return (await response.json()) as TaskProgressSnapshot;
    },
  };
}
