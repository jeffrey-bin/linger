export interface VoiceFailureOptions {
  recoverable?: boolean;
  cause?: unknown;
}

// Carries the reported failure_code and recovery decision as structured
// fields so callers never classify failures by message text.
export class VoiceFailure extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(
    code: string,
    message: string,
    options: VoiceFailureOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "VoiceFailure";
    this.code = code;
    this.recoverable = options.recoverable === true;
  }
}
