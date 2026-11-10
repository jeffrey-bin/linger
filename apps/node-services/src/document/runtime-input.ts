export const sha256Pattern = /^[a-f0-9]{64}$/;

/** A request the Document Runtime rejects before computing anything. */
export class RuntimeInputError extends Error {
  constructor(
    readonly code: "payload_too_large" | "validation_failed",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeInputError";
  }
}
