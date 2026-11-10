import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TeamHubMessage,
  TeamHubRoom,
} from "@/features/teamhub/teamhub-types";

import { anotherMeIntroStorageKey } from "./another-me-intro";
import { useAnotherMeOnboarding } from "./use-another-me-onboarding";

const agent = {
  display_name: "Bob's Another Me",
  id: "actor-am",
  kind: "agent",
};
const room = { direct_peer: agent, kind: "direct" } as unknown as TeamHubRoom;

function message(
  id: string,
  authorId: string,
  card?: { status: "pending" | "answered" },
) {
  return {
    author: { display_name: "", id: authorId, kind: "agent" },
    created_at: `2026-11-03T10:00:0${id.length}Z`,
    id,
    raw_message: "Hello there.",
    ...(card
      ? {
          card: {
            intent: "decision_requested",
            kind: "profile_setup_apps",
            status: card.status,
          },
        }
      : {}),
  } as unknown as TeamHubMessage;
}

function renderOnboarding(items: TeamHubMessage[]) {
  return renderHook(() =>
    useAnotherMeOnboarding({
      accountId: "account-bob",
      pages: [{ items }],
      room,
    }),
  );
}

describe("useAnotherMeOnboarding", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("plays the intro on a fresh setup and remembers it only once watched", () => {
    const key = anotherMeIntroStorageKey("account-bob");
    const { result } = renderOnboarding([
      message("g", agent.id),
      message("ap", agent.id, { status: "pending" }),
    ]);

    expect(result.current.introPlaying).toBe(true);
    expect(result.current.messagesHeld).toBe(true);
    expect(window.localStorage.getItem(key)).toBeNull();

    act(() => result.current.finishIntro());
    expect(result.current.introPlaying).toBe(false);
    expect(window.localStorage.getItem(key)).toBe("1");
  });

  it("opens normally once the Human has answered the setup card", () => {
    const { result } = renderOnboarding([
      message("g", agent.id),
      message("ap", agent.id, { status: "answered" }),
      message("ans", "actor-bob"),
    ]);

    expect(result.current.introPlaying).toBe(false);
    expect(result.current.messagesHeld).toBe(false);
  });

  it("does not replay after the intro was watched", () => {
    window.localStorage.setItem(anotherMeIntroStorageKey("account-bob"), "1");
    const { result } = renderOnboarding([
      message("g", agent.id),
      message("ap", agent.id, { status: "pending" }),
    ]);

    expect(result.current.introPlaying).toBe(false);
    expect(result.current.messagesHeld).toBe(false);
  });
});
