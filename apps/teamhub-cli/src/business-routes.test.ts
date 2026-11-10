import { describe, expect, it, vi } from "vitest";

const dependencyLoads = vi.hoisted(() => ({ citations: 0, creation: 0 }));
vi.mock("./domains/collaboration/message-citations.js", async (loadActual) => {
  dependencyLoads.citations++;
  return loadActual();
});
vi.mock(
  "./domains/collaboration/tools/creation-tools.js",
  async (loadActual) => {
    dependencyLoads.creation++;
    return loadActual();
  },
);

import {
  decodeAgentCommandResult,
  encodeAgentCommandBody,
} from "./business-routes.js";

describe("command dependency initialization", () => {
  it("encodes an ordinary message without initializing unrelated creation or Markdown parsing", async () => {
    expect(
      await encodeAgentCommandBody(
        "send_direct_message",
        { messages: ["Hello, [source](https://example.com)."] },
        "operation_1",
      ),
    ).toMatchObject({ messages: ["Hello, [source](https://example.com)."] });
    expect(dependencyLoads).toEqual({ citations: 0, creation: 0 });
  });

  it("checks decoded citation candidates with the full Markdown parser", async () => {
    await expect(
      encodeAgentCommandBody("send_direct_message", {
        messages: ["Source: &#xe200;cite&#xe202;turn1search0&#xe201;"],
      }),
    ).rejects.toMatchObject({
      code: "unsupported_message_citation",
      details: { sent: false },
    });
    expect(dependencyLoads).toEqual({ citations: 1, creation: 0 });
  });
});

describe("connected app execution", () => {
  it("decodes a tool result and a write held for confirmation", async () => {
    expect(
      await decodeAgentCommandResult("execute_app_tool", { data: null }),
    ).toEqual({ data: null });
    expect(
      await decodeAgentCommandResult("execute_app_tool", {
        status: "confirmation_pending",
        room_id: "room_one",
        message_id: "message_card",
        interaction_id: "interaction_one",
      }),
    ).toEqual({
      confirmation: {
        status: "pending",
        roomId: "room_one",
        messageId: "message_card",
        interactionId: "interaction_one",
      },
    });
    await expect(
      decodeAgentCommandResult("execute_app_tool", {}),
    ).rejects.toThrow();
  });
});
