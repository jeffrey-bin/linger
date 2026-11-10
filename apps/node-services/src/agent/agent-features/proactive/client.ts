import type { components } from "@linger/wire-contracts/teamhub-internal/types";

export type ProactiveWindow = components["schemas"]["ProactiveWindow"];

/** The Room is not the Agent's AnotherMe direct Room; it never will be. */
export class NotAnotherMeRoomError extends Error {}

/** TeamHub keeps window progress and the quiet-wake queue of AnotherMe Rooms. */
export interface ProactiveClient {
  window(
    roomId: string,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<ProactiveWindow | undefined>;
  /** False when another review judged the window first. */
  finish(
    roomId: string,
    agentId: string,
    judgedCount: number,
  ): Promise<boolean>;
  queueWake(roomId: string, agentId: string, body: string): Promise<void>;
}

export const createTeamHubProactiveClient = (options: {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetch?: typeof fetch;
}): ProactiveClient => {
  const post = (
    roomId: string,
    agentId: string,
    suffix: string,
    body: unknown,
    signal?: AbortSignal,
  ) =>
    (options.fetch ?? fetch)(
      new URL(
        ["v0", "rooms", roomId, "agents", agentId, "proactive"]
          .map(encodeURIComponent)
          .join("/") + suffix,
        options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
      ),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(10_000),
          ...(signal ? [signal] : []),
        ]),
        headers: {
          authorization: `Bearer ${options.serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
  return {
    async window(roomId, agentId, signal) {
      const response = await post(roomId, agentId, "/window", {}, signal);
      if (response.status === 404) throw new NotAnotherMeRoomError(roomId);
      if (!response.ok)
        throw new Error(`TeamHub proactive window failed: ${response.status}`);
      const body =
        (await response.json()) as components["schemas"]["ProactiveWindowResponse"];
      return body.window;
    },
    async finish(roomId, agentId, judgedCount) {
      const response = await post(roomId, agentId, "/window/finish", {
        judged_count: judgedCount,
      });
      if (response.status === 409) return false;
      if (!response.ok)
        throw new Error(`TeamHub proactive finish failed: ${response.status}`);
      return true;
    },
    async queueWake(roomId, agentId, body) {
      const response = await post(roomId, agentId, "/wakes", { body });
      if (!response.ok)
        throw new Error(`TeamHub proactive wake failed: ${response.status}`);
    },
  };
};
