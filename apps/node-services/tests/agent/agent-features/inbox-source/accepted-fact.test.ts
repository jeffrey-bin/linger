import { describe, expect, it } from "vitest";

import { inboxInputFact } from "../../../../src/agent/agent-features/inbox-source/accepted-fact.js";
import type { Message } from "../../../../src/agent/executor/types.js";

const queuedInput = (
  notification: Record<string, unknown> | undefined,
): Message =>
  ({
    messageId: "inbox-input-1",
    rawMessage: "",
    segments: [{ type: "text", content: "" }],
    sourceInboxIds: ["room:room-1"],
    invocationMessageIds: ["message-1"],
    ...(notification ? { acceptedNotification: notification } : {}),
  }) as unknown as Message;

describe("inboxInputFact", () => {
  it("reads the Message TeamHub froze into the input, with its sender", () => {
    const fact = inboxInputFact(
      queuedInput({
        inboxId: "room:room-1",
        cursorEncoding: "room_event_v1",
        after: "6",
        through: "7",
        targeted: true,
        messages: [
          {
            id: "message-1",
            body: "Hello @Agent",
            author: "Alice",
            authorActorId: "actor-alice",
            authorType: "user",
            mentioned: true,
            contextMessageIds: ["message-0"],
            resourceReferences: [
              { type: "document", content: "", document_id: "doc-1" },
            ],
          },
        ],
      }),
      { kind: "enqueue", runId: "local-run-1" },
    );
    expect(fact).toEqual({
      inboxId: "room:room-1",
      inputId: "inbox-input-1",
      targeted: true,
      dispatch: { kind: "enqueue", runId: "local-run-1" },
      messages: [
        {
          sequence: 7n,
          messageId: "message-1",
          disposition: "notify",
          mentioned: true,
          contextMessageIds: ["message-0"],
          resourceReferences: [
            { type: "document", content: "", document_id: "doc-1" },
          ],
          sender: {
            actorId: "actor-alice",
            displayName: "Alice",
            type: "user",
          },
          segments: [{ type: "text", content: "Hello @Agent" }],
        },
      ],
    });
  });

  it("reports a steer dispatch and an Agent sender", () => {
    const fact = inboxInputFact(
      queuedInput({
        inboxId: "taskmeta:task-1",
        through: "2",
        targeted: true,
        messages: [
          {
            id: "callback-1",
            body: "done",
            author: "Worker",
            authorActorId: "actor-worker",
            authorType: "agent",
            mentioned: false,
          },
        ],
      }),
      { kind: "steer", groupId: "steer-1" },
    );
    expect(fact?.dispatch).toEqual({ kind: "steer", groupId: "steer-1" });
    expect(fact?.messages?.[0]?.sender).toEqual({
      actorId: "actor-worker",
      displayName: "Worker",
      type: "agent",
    });
  });

  it("yields no fact for inputs without a frozen notification", () => {
    expect(
      inboxInputFact(queuedInput(undefined), {
        kind: "enqueue",
        runId: "local-run-1",
      }),
    ).toBeNull();
  });

  it("rejects a malformed notification instead of inventing a sender", () => {
    expect(() =>
      inboxInputFact(
        queuedInput({
          inboxId: "room:room-1",
          through: "1",
          messages: [{ id: "message-1", body: "no sender" }],
        }),
        { kind: "enqueue", runId: "local-run-1" },
      ),
    ).toThrow("Queued Inbox message has no body or sender");
    expect(() =>
      inboxInputFact(queuedInput({ inboxId: 7, messages: [] }), {
        kind: "enqueue",
        runId: "local-run-1",
      }),
    ).toThrow("Queued Inbox input has no canonical notification");
  });
});
