import { describe, expect, it } from "vitest";
import { sendMessageSequenceSchema } from "./collaboration/tools/send-message-sequence.js";

describe("TeamHub Collaboration send_message_sequence", () => {
  it("requires an immediate first bubble and rejects unknown model input", () => {
    expect(() =>
      sendMessageSequenceSchema.input.parse({
        inbox_id: "room_1",
        messages: [
          { content: "First", pause_before: "brief" },
          { content: "Second", pause_before: "natural" },
        ],
      }),
    ).toThrow();
    expect(() =>
      sendMessageSequenceSchema.input.parse({
        inbox_id: "room_1",
        messages: [
          { content: "First", pause_before: "none" },
          { content: "Second", pause_before: "brief" },
        ],
        delay_ms: 100,
      }),
    ).toThrow();
  });
});
