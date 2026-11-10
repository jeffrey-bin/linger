/** Provider-independent events. Audio/turn boundaries may be locally observed. */
export interface LiveTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LiveSetup {
  instructions: string;
  tools: LiveTool[];
  history: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface LiveFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export type LiveEvent =
  | { type: "speech_started"; itemId: string }
  | { type: "transcript_delta"; itemId: string; text: string }
  | { type: "transcript_completed"; itemId: string; text: string }
  | { type: "audio_started"; update: boolean }
  | { type: "audio_delta"; pcm: Int16Array }
  | { type: "audio_done" }
  | {
      type: "text_delta";
      text: string;
      /** Words of an update composed with tell(). */
      update: boolean;
    }
  | {
      type: "function_calls";
      calls: LiveFunctionCall[];
      /** Calls of an update composed with tell(), before or after its words. */
      update: boolean;
    }
  /** The model began a reply to the user (not an update). */
  | { type: "response_started" }
  | { type: "response_finished"; canceled: boolean }
  /** detail is the provider's own reason, bounded, for the log. */
  | { type: "provider_error"; code: string; detail: string };

export interface LiveSession {
  /** Await each append: a provider may pace buffered microphone frames. */
  appendAudio(frame: Int16Array): void | Promise<void>;
  mute(): void;
  unmute(): void;
  cancel(): void;
  /** Asks for a reply to the conversation so far. */
  respond(): void;
  /**
   * Tells the model the user heard only the first `audioMs` of the reply that
   * is playing, so its memory of the call matches what was said.
   */
  truncate(audioMs: number): void;
  /**
   * Says an update the model composes from the cue and what it already knows
   * of the call; with allowTools it may first call tools, and the response
   * after their results is still the update. Its words arrive as update text.
   */
  tell(cue: string, allowTools?: boolean): void;
  /** Adds application context without generating speech. */
  note(text: string): void;
  /**
   * `reply: false` adds the results without a new reply, for work the model
   * already announced.
   */
  sendToolResults(
    results: Array<{ callId: string; output: string }>,
    options?: { reply?: boolean },
  ): void;
  /** Changes the reply speed from the next response; false when out of range. */
  setSpeed(speed: number): boolean;
  events(): AsyncIterable<LiveEvent>;
  close(): Promise<void>;
}

export class LiveSessionError extends Error {
  constructor(
    readonly code: string,
    readonly transient: boolean,
    /** What the provider said when it ended the session, if anything. */
    readonly detail = "",
  ) {
    super(`Voice live session failed with ${code}`);
    this.name = "LiveSessionError";
  }
}
