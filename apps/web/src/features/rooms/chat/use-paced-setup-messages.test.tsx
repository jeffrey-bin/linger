import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import {
  pacedMessageDelay,
  usePacedSetupMessages,
} from "./use-paced-setup-messages";

const agentId = "actor-another-me";
const humanId = "actor-human";

function message(
  id: string,
  authorId: string,
  text: string,
  setupForm?: "profile_setup_apps" | "profile_setup_sources",
) {
  return {
    author: { display_name: "", id: authorId, kind: "agent" },
    created_at: "2026-11-03T10:00:00Z",
    id,
    raw_message: text,
    ...(setupForm
      ? {
          card: { intent: "decision_requested", kind: setupForm },
        }
      : {}),
  } as unknown as TeamHubMessage;
}

const greeting = message("greeting", agentId, "Hi Bob, I'm your Another Me.");
const appsCard = message(
  "apps",
  agentId,
  "Let me see where you talk about work.",
  "profile_setup_apps",
);

function renderPaced(
  props: Partial<Parameters<typeof usePacedSetupMessages>[0]> & {
    messages: readonly TeamHubMessage[];
  },
) {
  return renderHook((current) => usePacedSetupMessages(current), {
    initialProps: {
      agentActorId: agentId,
      paceInitial: true,
      paused: false,
      ...props,
    },
  });
}

describe("usePacedSetupMessages", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("releases a new setup burst one Agent Message at a time while typing", async () => {
    const { result } = renderPaced({ messages: [greeting, appsCard] });

    expect([...result.current.heldIds]).toEqual(["greeting", "apps"]);
    expect(result.current.typing).toBe(true);

    await act(() => vi.advanceTimersByTime(pacedMessageDelay(greeting)));
    expect([...result.current.heldIds]).toEqual(["apps"]);
    expect(result.current.typing).toBe(true);

    await act(() => vi.advanceTimersByTime(pacedMessageDelay(appsCard)));
    expect(result.current.heldIds.size).toBe(0);
    expect(result.current.typing).toBe(false);
  });

  it("holds the queue without typing while paused", async () => {
    const { rerender, result } = renderPaced({
      messages: [greeting, appsCard],
      paused: true,
    });

    await act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.heldIds.size).toBe(2);
    expect(result.current.typing).toBe(false);

    rerender({
      agentActorId: agentId,
      messages: [greeting, appsCard],
      paceInitial: true,
      paused: false,
    });
    expect(result.current.typing).toBe(true);
  });

  it("shows the Human's answer at once and paces the Agent's follow-up", async () => {
    const { rerender, result } = renderPaced({
      messages: [greeting, appsCard],
      paceInitial: false,
    });
    expect(result.current.heldIds.size).toBe(0);

    const answer = message("answer", humanId, "Connected");
    const ack = message("ack", agentId, "Got it.");
    const sources = message(
      "sources",
      agentId,
      "Do you have a personal website?",
      "profile_setup_sources",
    );
    rerender({
      agentActorId: agentId,
      messages: [greeting, appsCard, answer, ack, sources],
      paceInitial: false,
      paused: false,
    });

    expect([...result.current.heldIds]).toEqual(["ack", "sources"]);
    await act(() => vi.advanceTimersByTime(pacedMessageDelay(ack)));
    expect([...result.current.heldIds]).toEqual(["sources"]);
  });

  it("never paces an older page loaded above the Messages already shown", () => {
    const reply = message("reply", agentId, "Here is your summary.");
    const { rerender, result } = renderPaced({
      messages: [reply],
      paceInitial: false,
    });

    rerender({
      agentActorId: agentId,
      messages: [greeting, appsCard, reply],
      paceInitial: false,
      paused: false,
    });

    expect(result.current.heldIds.size).toBe(0);
    expect(result.current.typing).toBe(false);
  });

  it("does not pace ordinary Agent replies or Messages already read", () => {
    const reply = message("reply", agentId, "Here is your summary.");
    const { rerender, result } = renderPaced({
      messages: [greeting, appsCard],
      paceInitial: false,
    });

    rerender({
      agentActorId: agentId,
      messages: [greeting, appsCard, reply],
      paceInitial: false,
      paused: false,
    });

    expect(result.current.heldIds.size).toBe(0);
    expect(result.current.typing).toBe(false);
  });
});
