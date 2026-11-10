export type GenerationFailureDisposition = "retryable" | "terminal";

export type ActorAssetErrorCode =
  | "WIKI_OPERATION_FAILED"
  | "WIKI_OPERATION_RETRYABLE"
  | "WIKI_COMPUTER_OFFLINE";

export class ActorAssetError extends Error {
  constructor(
    readonly code: ActorAssetErrorCode,
    message: string,
    readonly disposition: GenerationFailureDisposition = code ===
    "WIKI_OPERATION_FAILED"
      ? "terminal"
      : "retryable",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ActorAssetError";
  }
}
