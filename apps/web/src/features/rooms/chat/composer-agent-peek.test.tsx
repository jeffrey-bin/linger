import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ComposerAgentPeek,
  PEEK_IDLE_MS,
  PEEK_TYPING_MS,
  useComposerPeek,
} from "./composer-agent-peek";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Types one character every `stepMs` until the draft reaches `length`. */
function typeSteadily(
  peek: { current: ReturnType<typeof useComposerPeek> },
  from: number,
  length: number,
  stepMs = 250,
) {
  for (let next = from; next <= length; next++) {
    act(() => {
      peek.current.typed(next);
      vi.advanceTimersByTime(stepMs);
    });
  }
}

describe("useComposerPeek", () => {
  it("stays down for a short reply however long it takes", () => {
    const { result } = renderHook(() => useComposerPeek());
    typeSteadily(result, 1, 6, 800);
    act(() => {
      vi.advanceTimersByTime(PEEK_TYPING_MS);
    });
    expect(result.current.visible).toBe(false);
  });

  it("rises once a long enough draft has been typed for a while, not on the first key", () => {
    const { result } = renderHook(() => useComposerPeek());
    typeSteadily(result, 1, 8);
    expect(result.current.visible).toBe(false);
    typeSteadily(result, 9, 13);
    expect(result.current.visible).toBe(true);
  });

  it("does not count a paste as typing", () => {
    const { result } = renderHook(() => useComposerPeek());
    act(() => {
      result.current.pasted();
      result.current.typed(80);
    });
    act(() => {
      vi.advanceTimersByTime(PEEK_TYPING_MS * 2);
    });
    expect(result.current.visible).toBe(false);
  });

  it("restarts the count after a long pause between keys", () => {
    const { result } = renderHook(() => useComposerPeek());
    act(() => {
      result.current.pasted();
    });
    act(() => {
      result.current.typed(20);
    });
    typeSteadily(result, 21, 25, 2000);
    expect(result.current.visible).toBe(false);
  });

  it("goes down during a long pause and comes straight back when typing resumes", () => {
    const { result } = renderHook(() => useComposerPeek());
    typeSteadily(result, 1, 14);
    expect(result.current.visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(PEEK_IDLE_MS);
    });
    expect(result.current.visible).toBe(false);
    act(() => {
      result.current.typed(15);
    });
    expect(result.current.visible).toBe(true);
  });

  it("nods once on send, then ducks away and waits for a fresh draft", () => {
    const { result } = renderHook(() => useComposerPeek());
    typeSteadily(result, 1, 14);
    const blinkBefore = result.current.blink;
    act(() => {
      result.current.submitted();
    });
    expect(result.current.blink).toBe(blinkBefore + 1);
    expect(result.current.visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.visible).toBe(false);
    act(() => {
      result.current.typed(1);
    });
    expect(result.current.visible).toBe(false);
  });

  it("stays down for the rest of the draft once clicked away", () => {
    const { result } = renderHook(() => useComposerPeek());
    typeSteadily(result, 1, 14);
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.visible).toBe(false);
    typeSteadily(result, 15, 30);
    expect(result.current.visible).toBe(false);
    // A new draft can summon them again.
    act(() => {
      result.current.typed(0);
    });
    typeSteadily(result, 1, 14);
    expect(result.current.visible).toBe(true);
  });

  it("ducks away when the draft is cleared", () => {
    const { result } = renderHook(() => useComposerPeek());
    typeSteadily(result, 1, 14);
    act(() => {
      result.current.typed(0);
    });
    expect(result.current.visible).toBe(false);
  });
});

describe("ComposerAgentPeek", () => {
  const agent = (index: number) => ({
    display_name: `Agent ${index}`,
    id: `agent-${index}`,
  });

  it("shows at most three Agents and counts the rest", () => {
    render(
      <ComposerAgentPeek
        agents={[1, 2, 3, 4, 5].map(agent)}
        blink={0}
        onDismiss={vi.fn()}
        visible={false}
      />,
    );
    expect(screen.getAllByTestId("composer-peeking-agent")).toHaveLength(3);
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("can be clicked away only while it peeks", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <ComposerAgentPeek
        agents={[agent(1)]}
        blink={0}
        onDismiss={onDismiss}
        visible={false}
      />,
    );
    const watcher = screen.getByTestId("composer-peeking-agent");
    expect(watcher).not.toHaveClass("pointer-events-auto");
    rerender(
      <ComposerAgentPeek
        agents={[agent(1)]}
        blink={0}
        onDismiss={onDismiss}
        visible
      />,
    );
    expect(watcher).toHaveClass("pointer-events-auto");
    fireEvent.click(watcher);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("returns focus when a focused avatar retracts", () => {
    const onReturnFocus = vi.fn();
    const { rerender } = render(
      <ComposerAgentPeek
        agents={[agent(1)]}
        blink={0}
        onDismiss={vi.fn()}
        onReturnFocus={onReturnFocus}
        visible
      />,
    );
    screen.getByRole("button", { name: /Dismiss .* avatar/ }).focus();
    rerender(
      <ComposerAgentPeek
        agents={[agent(1)]}
        blink={0}
        onDismiss={vi.fn()}
        onReturnFocus={onReturnFocus}
        visible={false}
      />,
    );
    expect(onReturnFocus).toHaveBeenCalledOnce();
  });

  it("returns focus when the focused agent is removed", () => {
    const onReturnFocus = vi.fn();
    const { rerender } = render(
      <ComposerAgentPeek
        agents={[agent(1)]}
        blink={0}
        onDismiss={vi.fn()}
        onReturnFocus={onReturnFocus}
        visible
      />,
    );
    screen.getByRole("button", { name: /Dismiss .* avatar/ }).focus();
    rerender(
      <ComposerAgentPeek
        agents={[]}
        blink={0}
        onDismiss={vi.fn()}
        onReturnFocus={onReturnFocus}
        visible
      />,
    );
    expect(onReturnFocus).toHaveBeenCalledOnce();
  });

  it("renders nothing without an addressed Agent", () => {
    render(
      <ComposerAgentPeek agents={[]} blink={0} onDismiss={vi.fn()} visible />,
    );
    expect(screen.queryByTestId("composer-agent-peek")).not.toBeInTheDocument();
  });

  it("stays still for people who ask for reduced motion", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    render(
      <ComposerAgentPeek
        agents={[agent(1)]}
        blink={0}
        onDismiss={vi.fn()}
        visible
      />,
    );
    expect(screen.queryByTestId("composer-agent-peek")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
