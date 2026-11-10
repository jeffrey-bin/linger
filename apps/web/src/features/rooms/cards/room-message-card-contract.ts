export interface RoomCardDecision {
  connectionId?: string;
  answers?: Record<string, string | string[]>;
  attachmentUploadIds?: string[];
  decision: "approve" | "connected" | "deny" | "done" | "skipped" | "submit";
  expectedVersion: number;
  feedback?: string;
  links?: string[];
  messageId: string;
  /** The decision the card names. */
  requestId: string;
}
