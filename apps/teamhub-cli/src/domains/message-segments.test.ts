import { describe, expect, it } from "vitest";
import {
  fromTeamHubPublicInboxId,
  fromTeamHubRoomInboxId,
  sendMessageInboxIdSchema,
  toTeamHubPublicInboxId,
  toTeamHubRoomInboxId,
} from "./collaboration/message-segments.js";

describe("TeamHub Collaboration Inbox identifiers", () => {
  it("accepts bare Room, Thread and Task targets", () => {
    expect(sendMessageInboxIdSchema.parse("room_1")).toBe("room_1");
    expect(sendMessageInboxIdSchema.parse("thread:thread_1")).toBe(
      "thread:thread_1",
    );
    const taskInbox = `task:${`t.${"a".repeat(126)}`}`;
    expect(taskInbox.length).toBe(133);
    expect(sendMessageInboxIdSchema.parse(taskInbox)).toBe(taskInbox);
  });

  it("rejects typed Room, private, malformed, and oversized identifiers", () => {
    for (const value of [
      "meta:actor_1:task_1",
      "room:room_1",
      "task_1",
      "room:",
      "task:bad/task",
      `room:${"a".repeat(65)}`,
      `task:${"a".repeat(129)}`,
    ]) {
      expect(() => sendMessageInboxIdSchema.parse(value)).toThrow();
    }
  });

  it("adapts only Room identifiers at the TeamHub boundary", () => {
    expect(toTeamHubRoomInboxId("room_1")).toBe("room:room_1");
    expect(fromTeamHubRoomInboxId("room:room_1")).toBe("room_1");
    expect(toTeamHubPublicInboxId("room_1")).toBe("room:room_1");
    expect(fromTeamHubPublicInboxId("room:room_1")).toBe("room_1");
    expect(toTeamHubPublicInboxId("task:task_1")).toBe("task:task_1");
    expect(fromTeamHubPublicInboxId("task:task_1")).toBe("task:task_1");
    expect(toTeamHubPublicInboxId("thread:thread_1")).toBe("thread:thread_1");
    expect(fromTeamHubPublicInboxId("thread:thread_1")).toBe("thread:thread_1");
  });
});
