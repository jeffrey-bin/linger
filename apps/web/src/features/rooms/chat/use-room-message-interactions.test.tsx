import { Profiler, type PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createTeamHubTestSeed } from "@/test/teamhub-seed";

import { useRoomMessageInteractions } from "./use-room-message-interactions";

describe("Room Message interactions", () => {
  it("does not commit a render when clearing absent context", () => {
    const onRender = vi.fn();

    const { result } = renderHook(
      () =>
        useRoomMessageInteractions({
          mentionOptions: [],
          roomId: "room",
          tenantId: "tenant",
        }),
      {
        wrapper: ({ children }: PropsWithChildren) => (
          <Profiler id="context" onRender={onRender}>
            {children}
          </Profiler>
        ),
      },
    );
    onRender.mockClear();
    act(() => result.current.clearContext([]));
    act(() => result.current.clearContext(["absent"]));
    act(() => result.current.clearContext());
    expect(onRender).not.toHaveBeenCalled();
    expect(result.current.selectedContextMessages).toEqual([]);
  });

  it("ignores an old Room's completion after selecting context in another Room", () => {
    const message = fixtureAgentMessage();

    const { result, rerender } = renderHook(
      ({ roomId }) =>
        useRoomMessageInteractions({
          mentionOptions: [],
          roomId,
          tenantId: message.tenant_id,
        }),
      { initialProps: { roomId: message.room_id } },
    );
    act(() => result.current.replyToMessage(message));
    const clearOldContext = result.current.clearContext;
    rerender({ roomId: "another-room" });
    const next = { ...message, id: "next", room_id: "another-room" };
    act(() => result.current.replyToMessage(next));
    act(() => clearOldContext([message.id]));
    expect(result.current.selectedContextMessages).toEqual([next]);
  });

  it("clears only the context committed by an earlier in-flight Message", () => {
    const first = fixtureAgentMessage();
    const next = { ...first, id: "message-next", raw_message: "Next context" };

    const { result } = renderHook(() =>
      useRoomMessageInteractions({
        mentionOptions: [],
        roomId: first.room_id,
        tenantId: first.tenant_id,
      }),
    );

    act(() => result.current.replyToMessage(first));
    act(() => result.current.clearContext([first.id]));
    act(() => result.current.replyToMessage(next));
    act(() => result.current.clearContext([first.id]));

    expect(result.current.selectedContextMessages).toEqual([next]);
  });

  it("clears selected context across a Room round trip", () => {
    const message = fixtureAgentMessage();

    const { rerender, result } = renderHook(
      ({ roomId }) =>
        useRoomMessageInteractions({
          mentionOptions: [],
          roomId,
          tenantId: message.tenant_id,
        }),
      { initialProps: { roomId: message.room_id } },
    );

    act(() => result.current.replyToMessage(message));
    expect(result.current.selectedContextMessages).toEqual([message]);

    rerender({ roomId: "room-another" });
    expect(result.current.selectedContextMessages).toEqual([]);

    rerender({ roomId: message.room_id });
    expect(result.current.selectedContextMessages).toEqual([]);
  });
});

function fixtureAgentMessage() {
  const fixture = createTeamHubTestSeed();
  const message = [...fixture.messagesByRoom.values()]
    .flat()
    .find((candidate) => candidate.author.kind === "agent" && !candidate.card);
  if (!message) throw new Error("Agent Message fixture is unavailable");
  return message;
}
