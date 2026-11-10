import { describe, expect, it } from "vitest";
import { encodeAgentCommandBody } from "../business-routes.js";

describe("Room creation payload", () => {
  it("preserves caller input separately from the normalized approval payload", async () => {
    const input = {
      name: "  Review Room  ",
      description: "Release review",
      member_ids: ["actor_b", "actor_a"],
      artifacts: ["document_brief", "document_evidence"],
      initial_message_segments: [{ type: "text", content: "Start review" }],
    };
    expect(await encodeAgentCommandBody("create_room", input)).toEqual({
      request_kind: "room_creation",
      caller_input: input,
      effective_payload: {
        ...input,
        name: "Review Room",
        member_ids: ["actor_a", "actor_b"],
      },
    });
    expect(input.member_ids).toEqual(["actor_b", "actor_a"]);
  });
});
