import { describe, expect, it } from "vitest";
import { sendDirectMessageSchema } from "./collaboration/tools/send-direct-message.js";

describe("TeamHub Collaboration send_direct_message", () => {
  it("rejects blank, oversized, and unknown model input", () => {
    expect(() =>
      sendDirectMessageSchema.input.parse({ messages: ["   "] }),
    ).toThrow();
    expect(() =>
      sendDirectMessageSchema.input.parse({
        messages: ["x".repeat(50_001)],
      }),
    ).toThrow();
    expect(() =>
      sendDirectMessageSchema.input.parse({
        messages: ["valid"],
        recipient_actor_id: "actor_forbidden",
      }),
    ).toThrow();
  });
});
