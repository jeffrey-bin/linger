import type { components } from "@linger/wire-contracts/teamhub-internal/types";

export type VoiceObservation = components["schemas"]["VoiceObservation"];
export type VoiceDictationCommitRequest =
  components["schemas"]["VoiceDictationCommitRequest"];
export type VoiceSessionPurpose = components["schemas"]["VoiceSessionPurpose"];
export type VoiceObservationReceipt =
  components["schemas"]["VoiceObservationReceipt"];
export type VoiceLiveContext = components["schemas"]["VoiceLiveContext"];
export type VoiceLiveReply = components["schemas"]["VoiceLiveReply"];
export type VoiceLiveReplyReceipt =
  components["schemas"]["VoiceLiveReplyReceipt"];
export type VoiceLiveToolCall = components["schemas"]["VoiceLiveToolCall"];
export type VoiceLiveToolResult = components["schemas"]["VoiceLiveToolResult"];
export type VoiceLiveTask = components["schemas"]["VoiceLiveTask"];
export type VoiceLiveTaskList = components["schemas"]["VoiceLiveTaskList"];
export type VoiceLiveAlert = components["schemas"]["VoiceLiveAlert"];
export type VoiceLiveRuntimeEvent =
  components["schemas"]["VoiceLiveRuntimeEvent"];
export type VoiceLiveClientEvent =
  components["schemas"]["VoiceLiveClientEvent"];

export class TeamHubVoiceRuntimeError extends Error {
  constructor(readonly status: number) {
    super(`TeamHub Voice Runtime request failed with ${status}`);
    this.name = "TeamHubVoiceRuntimeError";
  }
}

export class TeamHubVoiceRuntimeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | (() => Promise<string>),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async reportObservation(
    observation: VoiceObservation,
    signal?: AbortSignal,
  ): Promise<VoiceObservationReceipt> {
    return this.request(
      "POST",
      "/internal/v1/voice/observations",
      observation,
      signal,
    );
  }

  async getLiveContext(
    voiceSessionId: string,
    signal?: AbortSignal,
  ): Promise<VoiceLiveContext> {
    return this.request(
      "GET",
      `/internal/v1/voice/sessions/${encodeURIComponent(voiceSessionId)}/live-context`,
      undefined,
      signal,
    );
  }

  async listLiveTasks(
    voiceSessionId: string,
    signal?: AbortSignal,
  ): Promise<VoiceLiveTaskList> {
    return this.request(
      "GET",
      `/internal/v1/voice/sessions/${encodeURIComponent(voiceSessionId)}/live-tasks`,
      undefined,
      signal,
    );
  }

  /**
   * Follows the hint stream of a call's tasks: calls changed() once the
   * stream is open and on every hint, and returns when the stream ends.
   */
  async watchLiveTasks(
    voiceSessionId: string,
    changed: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    const token =
      typeof this.token === "string" ? this.token : await this.token();
    const response = await this.fetchImpl(
      new URL(
        `/internal/v1/voice/sessions/${encodeURIComponent(voiceSessionId)}/live-task-events`,
        this.baseUrl,
      ),
      {
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "text/event-stream",
        },
      },
    );
    if (!response.ok || !response.body) {
      throw new TeamHubVoiceRuntimeError(response.status);
    }
    changed();
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (/^event: changed$/m.test(block)) changed();
      }
    }
  }

  async reportLiveReply(
    reply: VoiceLiveReply,
    signal?: AbortSignal,
  ): Promise<VoiceLiveReplyReceipt> {
    return this.request(
      "POST",
      "/internal/v1/voice/live-replies",
      reply,
      signal,
    );
  }

  async executeLiveToolCall(
    call: VoiceLiveToolCall,
    signal?: AbortSignal,
  ): Promise<VoiceLiveToolResult> {
    return this.request(
      "POST",
      "/internal/v1/voice/live-tool-calls",
      call,
      signal,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const token =
      typeof this.token === "string" ? this.token : await this.token();
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      signal: signal ?? AbortSignal.timeout(2_000),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new TeamHubVoiceRuntimeError(response.status);
    }
    return (await response.json()) as T;
  }
}
