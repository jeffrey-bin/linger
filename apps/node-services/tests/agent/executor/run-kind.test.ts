import { describe, expect, it } from "vitest";
import type { ExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import { runKind } from "../../../src/agent/executor/run-kind.js";
import type { Message } from "../../../src/agent/executor/types.js";

const meta = {
  kind: "meta",
  agentId: "agent-1",
  roomId: "room-1",
} as ExecutionContextRef;

const followUp = {
  messageId: "follow-up",
  rawMessage: "Report progress",
  segments: [{ type: "text", content: "Report progress" }],
} as Message;

function inbox(
  inboxId: string,
  ...messages: Record<string, unknown>[]
): Message {
  return {
    ...followUp,
    messageId: `input-${inboxId}`,
    acceptedNotification: {
      inboxId,
      after: "0",
      through: "1",
      messages: messages.map((message, index) => ({
        id: `message-${index}`,
        body: "",
        author: "Alice",
        mentioned: false,
        ...message,
      })),
    },
  } as unknown as Message;
}

describe("runKind", () => {
  it.each([
    [
      "chat",
      inbox("room:r", { authorType: "user", messageKind: "conversation" }),
    ],
    [
      "agent_message",
      inbox("room:r", { authorType: "agent", messageKind: "conversation" }),
    ],
    [
      "routine",
      inbox("room:r", { messageKind: "agent_runtime", firedRoutine: true }),
    ],
    ["proactive", inbox("room:r", { messageKind: "agent_runtime" })],
    ["task_callback", inbox("room:r", { messageKind: "task_terminal_notice" })],
    ["task_callback", inbox("taskmeta:task-1", { authorType: "agent" })],
    ["follow_up", followUp],
  ] as const)("names a Meta Run of %s", (kind, message) => {
    expect(runKind(meta, [message])).toBe(kind);
  });

  it("names a Run by its Context outside Meta", () => {
    const message = inbox("room:r", { authorType: "user" });
    expect(
      runKind({ kind: "alter_ego", agentId: "agent-1", taskId: "task-1" }, [
        message,
      ]),
    ).toBe("task");
    expect(
      runKind({ kind: "document", agentId: "agent-1", documentId: "doc-1" }, [
        message,
      ]),
    ).toBe("document");
  });

  it("takes the kind someone most likely waits on from a merged Run", () => {
    expect(
      runKind(meta, [
        inbox("room:r", { messageKind: "agent_runtime" }),
        followUp,
        inbox(
          "room:r",
          { messageKind: "agent_runtime", firedRoutine: true },
          { authorType: "user", messageKind: "conversation" },
        ),
      ]),
    ).toBe("chat");
  });
});
