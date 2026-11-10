import { describe, expect, it } from "vitest";
import {
  compareSessionlyMessages,
  messageCursor,
  messagesAfterCursor,
} from "../../src/memory/sessionly-checkpoint.js";
import type { RoomMessage } from "../../src/memory/types.js";

const message = (id: string, createdAt: string) =>
  ({ id, createdAt }) as RoomMessage;

describe("session message ordering and checkpoint", () => {
  it("uses the highest id at the same replay instant, independent of insertion order", () => {
    const messages = [
      message("message_z", "2026-08-25T02:15:53Z"),
      message("message_a", "2026-08-25T10:15:53+08:00"),
    ];
    const ordered = [...messages].sort(compareSessionlyMessages);
    expect(ordered.map((m) => m.id)).toEqual(["message_a", "message_z"]);
    expect(
      messagesAfterCursor(messages, messageCursor(ordered.at(-1)!)),
    ).toEqual([]);
    expect(
      messagesAfterCursor(messages, messageCursor(ordered[0]!)).map(
        (m) => m.id,
      ),
    ).toEqual(["message_z"]);
  });

  it("orders replay event times rather than physical import order and retains new messages", () => {
    const messages = [
      message("later", "2026-09-02T04:00:00Z"),
      message("earlier", "2026-09-02T10:00:00+08:00"),
    ];
    const ordered = [...messages].sort(compareSessionlyMessages);
    expect(ordered.map((m) => m.id)).toEqual(["earlier", "later"]);
    expect(
      messagesAfterCursor(messages, messageCursor(ordered.at(-1)!)),
    ).toEqual([]);
    expect(
      messagesAfterCursor(
        [...messages, message("new", "2026-09-02T04:00:01Z")],
        messageCursor(ordered.at(-1)!),
      ).map((m) => m.id),
    ).toEqual(["new"]);
    expect(messagesAfterCursor(messages, undefined)).toEqual(messages);
  });
});
