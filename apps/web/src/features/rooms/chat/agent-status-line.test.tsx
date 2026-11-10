import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_STATUS_LINE_TIMING as timing,
  advanceAgentStatusLine,
  useAgentStatusLine,
  type AgentStatusLineContent,
  type AgentStatusLineState,
  type AgentStatusLineTarget,
} from "./agent-status-line";

const live = (text: string): AgentStatusLineContent => ({ tone: "live", text });
const tool = (
  text: string,
  runningActivityId?: string,
): AgentStatusLineContent => ({
  tone: "live",
  text,
  ...(runningActivityId ? { runningActivityId } : {}),
});
const thought = live;
/** An Agent whose current group has these entries, keyed by their text. */
const queued = (id: string, ...texts: string[]): AgentStatusLineTarget => {
  const queue = texts.map((text) => ({ key: text, content: live(text) }));
  return { id, content: queue.at(-1)!.content, queue };
};
const failed: AgentStatusLineContent = { tone: "danger", text: "Run failed" };
const start: AgentStatusLineState = {
  changedAt: Number.NEGATIVE_INFINITY,
  lines: {},
  turnAt: Number.NEGATIVE_INFINITY,
};

function run(
  steps: readonly [number, readonly AgentStatusLineTarget[], boolean?][],
) {
  let state = start;
  const shown: string[] = [];
  for (const [now, targets, paused = false] of steps) {
    state = advanceAgentStatusLine(state, { now, paused, targets });
    const current = state.current;
    const text =
      current === undefined
        ? "-"
        : `${current.id}:${current.content.tone === "wait" ? "···" : current.content.text}${current.minutes ? ` · ${current.minutes}m` : ""}`;
    shown.push(text);
  }
  return shown;
}

describe("advanceAgentStatusLine", () => {
  it("rotates running Agents in roster order, one turn each", () => {
    const targets = [
      { id: "mira", content: live("Searching “flights”") },
      { id: "orin", content: { tone: "wait" } as const },
      { id: "pax", content: live("Reading notes.md") },
    ];
    expect(
      run([
        [0, targets],
        [timing.turnMs - 1, targets],
        [timing.turnMs, targets],
        [timing.turnMs * 2, targets],
        [timing.turnMs * 3, targets],
      ]),
    ).toEqual([
      "mira:Searching “flights”",
      "mira:Searching “flights”",
      "orin:···",
      "pax:Reading notes.md",
      "mira:Searching “flights”",
    ]);
  });

  it("keeps a new line at least the minimum time unless its Agent left", () => {
    const first = [{ id: "mira", content: live("Reading a.md") }];
    const second = [{ id: "mira", content: live("Editing a.md") }];
    expect(
      run([
        [0, first],
        [100, second],
        [timing.minShowMs, second],
      ]),
    ).toEqual(["mira:Reading a.md", "mira:Reading a.md", "mira:Editing a.md"]);

    const both = [
      { id: "mira", content: live("Reading a.md") },
      { id: "pax", content: live("Editing b.md") },
    ];
    const paxOnly = [{ id: "pax", content: live("Editing b.md") }];
    expect(
      run([
        [0, both],
        [100, paxOnly],
      ]),
    ).toEqual(["mira:Reading a.md", "pax:Editing b.md"]);
  });

  it("replaces waiting dots with the first real status at once", () => {
    const waiting = [{ id: "mira", content: { tone: "wait" } as const }];
    const searching = [{ id: "mira", content: live("Searching “flights”") }];
    expect(
      run([
        [0, waiting],
        [100, searching],
      ]),
    ).toEqual(["mira:···", "mira:Searching “flights”"]);
  });

  it("keeps a finished Activity's line until the next status", () => {
    const running = [{ id: "orin", content: tool("Browsing the web", "a1") }];
    const finished = [{ id: "orin", content: tool("Browsing the web") }];
    expect(
      run([
        [0, running],
        [1000, finished],
        [60_000, finished],
      ]),
    ).toEqual([
      "orin:Browsing the web",
      "orin:Browsing the web",
      "orin:Browsing the web",
    ]);
  });

  it("plays the shown Agent's queue one entry at a time", () => {
    const reading = [{ id: "orin", content: live("Reading a.md") }];
    const group = [
      queued(
        "orin",
        "Comparing fares",
        "Fetching example.com",
        "Reading r1.json",
      ),
    ];
    const min = timing.minShowMs;
    expect(
      run([
        [0, reading],
        [100, group],
        [min - 1, group],
        [min, group],
        [min * 2 - 1, group],
        [min * 2, group],
        [min * 3, group],
        [60_000, group],
      ]),
    ).toEqual([
      "orin:Reading a.md",
      "orin:Reading a.md",
      "orin:Reading a.md",
      "orin:Comparing fares",
      "orin:Comparing fares",
      "orin:Fetching example.com",
      "orin:Reading r1.json",
      "orin:Reading r1.json",
    ]);
  });

  it("starts a new group at once and drops the rest of the old one", () => {
    const first = [queued("orin", "Comparing fares", "Fetching a.com")];
    const longer = [
      queued("orin", "Comparing fares", "Fetching a.com", "Reading a.json"),
    ];
    const next = [queued("orin", "Checking sources", "Fetching b.com")];
    const min = timing.minShowMs;
    expect(
      run([
        [0, first],
        [100, longer],
        [500, next],
        [min, next],
        [min * 2, next],
      ]),
    ).toEqual([
      "orin:Fetching a.com",
      "orin:Fetching a.com",
      "orin:Fetching a.com",
      "orin:Checking sources",
      "orin:Fetching b.com",
    ]);
  });

  it("keeps at most a few entries waiting behind the shown one", () => {
    const reading = [{ id: "orin", content: live("Reading a.md") }];
    const burst = [queued("orin", "One", "Two", "Three", "Four", "Five")];
    const min = timing.minShowMs;
    expect(
      run([
        [0, reading],
        [100, burst],
        [min, burst],
        [min * 2, burst],
        [min * 3, burst],
        [min * 4, burst],
      ]),
    ).toEqual([
      "orin:Reading a.md",
      "orin:Reading a.md",
      "orin:Two",
      "orin:Three",
      "orin:Four",
      "orin:Five",
    ]);
  });

  it("shows only the latest entry of an Agent not holding the line", () => {
    const before = [
      { id: "mira", content: live("Reading a.md") },
      { id: "pax", content: live("Editing b.md") },
    ];
    const paxGroup = [
      before[0]!,
      queued("pax", "Planning the fix", "Running tests", "Checking changes"),
    ];
    expect(
      run([
        [0, before],
        [100, paxGroup],
        [timing.minShowMs, paxGroup],
        [timing.minShowMs * 2, paxGroup],
      ]),
    ).toEqual([
      "mira:Reading a.md",
      "mira:Reading a.md",
      "pax:Checking changes",
      "pax:Checking changes",
    ]);
  });

  it("shows how long a running Activity has run, from one minute", () => {
    const sleeping = [
      { id: "mira", content: tool("Waiting for replies", "a1") },
    ];
    const done = [{ id: "mira", content: tool("Waiting for replies") }];
    const next = [{ id: "mira", content: tool("Waiting for replies", "a2") }];
    expect(
      run([
        [0, sleeping],
        [59_999, sleeping],
        [60_000, sleeping],
        [125_000, sleeping],
        [126_000, done],
        [200_000, next],
      ]),
    ).toEqual([
      "mira:Waiting for replies",
      "mira:Waiting for replies",
      "mira:Waiting for replies · 1m",
      "mira:Waiting for replies · 2m",
      "mira:Waiting for replies",
      "mira:Waiting for replies",
    ]);
  });

  it("shows failures only after every other Agent is done", () => {
    const working = [
      { id: "mira", content: live("Running a command") },
      { id: "orin", content: failed },
    ];
    const done = [{ id: "orin", content: failed }];
    expect(
      run([
        [0, working],
        [timing.turnMs, working],
        [timing.turnMs * 2, done],
      ]),
    ).toEqual([
      "mira:Running a command",
      "mira:Running a command",
      "orin:Run failed",
    ]);
  });

  it("does not rotate while paused", () => {
    const targets = [
      { id: "mira", content: live("Reading a.md") },
      { id: "pax", content: live("Editing b.md") },
    ];
    expect(
      run([
        [0, targets],
        [timing.turnMs, targets, true],
        [timing.turnMs * 2, targets, true],
        [timing.turnMs * 2 + 1, targets],
      ]),
    ).toEqual([
      "mira:Reading a.md",
      "mira:Reading a.md",
      "mira:Reading a.md",
      "pax:Editing b.md",
    ]);
  });

  it("moves to an Agent whose status changed without waiting for its turn", () => {
    const before = [
      { id: "mira", content: live("Reading a.md") },
      { id: "orin", content: live("Searching “flights”") },
      { id: "pax", content: live("Editing b.md") },
    ];
    const paxChanged = [
      before[0]!,
      before[1]!,
      { id: "pax", content: live("Running a command") },
    ];
    expect(
      run([
        [0, before],
        [300, paxChanged],
        [timing.minShowMs - 1, paxChanged],
        [timing.minShowMs, paxChanged],
        // pax holds a full turn; then rotation goes on from it.
        [timing.minShowMs + timing.turnMs - 1, paxChanged],
        [timing.minShowMs + timing.turnMs, paxChanged],
      ]),
    ).toEqual([
      "mira:Reading a.md",
      "mira:Reading a.md",
      "mira:Reading a.md",
      "pax:Running a command",
      "pax:Running a command",
      "mira:Reading a.md",
    ]);
  });

  it("shows several changes in the order they happened", () => {
    const before = [
      { id: "mira", content: live("Reading a.md") },
      { id: "orin", content: live("Searching “flights”") },
      { id: "pax", content: live("Editing b.md") },
    ];
    const paxChanged = [
      before[0]!,
      before[1]!,
      { id: "pax", content: live("Running a command") },
    ];
    const bothChanged = [
      before[0]!,
      { id: "orin", content: thought("Comparing fares") },
      paxChanged[2]!,
    ];
    expect(
      run([
        [0, before],
        [100, paxChanged],
        [200, bothChanged],
        [timing.minShowMs, bothChanged],
        [timing.minShowMs * 2, bothChanged],
      ]),
    ).toEqual([
      "mira:Reading a.md",
      "mira:Reading a.md",
      "mira:Reading a.md",
      "pax:Running a command",
      "orin:Comparing fares",
    ]);
  });

  it("does not move for dots, lines up at first render, or while paused", () => {
    const before = [
      { id: "mira", content: live("Reading a.md") },
      { id: "pax", content: live("Editing b.md") },
    ];
    const paxWaiting = [
      before[0]!,
      { id: "pax", content: { tone: "wait" } as const },
    ];
    const paxChanged = [
      before[0]!,
      { id: "pax", content: live("Running a command") },
    ];
    expect(
      run([
        [0, before],
        [100, before],
        [200, paxWaiting],
        [timing.minShowMs, paxWaiting],
        [timing.minShowMs + 1, paxChanged, true],
        [timing.turnMs + 1, paxChanged, true],
        [timing.turnMs + 2, paxChanged],
      ]),
    ).toEqual([
      "mira:Reading a.md",
      "mira:Reading a.md",
      "mira:Reading a.md",
      "mira:Reading a.md",
      "mira:Reading a.md",
      "mira:Reading a.md",
      "pax:Running a command",
    ]);
  });

  it("keeps the same state object while nothing changes", () => {
    const targets = [{ id: "mira", content: live("Reading a.md") }];
    const first = advanceAgentStatusLine(start, {
      now: 0,
      paused: false,
      targets,
    });
    const settled = advanceAgentStatusLine(first, {
      now: timing.rollMs,
      paused: false,
      targets,
    });
    expect(
      advanceAgentStatusLine(settled, {
        now: timing.rollMs + 500,
        paused: false,
        targets: [{ id: "mira", content: live("Reading a.md") }],
      }),
    ).toBe(settled);
  });
});

describe("useAgentStatusLine", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps one timer across rerenders and clears it once on unmount", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const { rerender, result, unmount } = renderHook(
      ({ targets, paused }) => useAgentStatusLine(targets, paused),
      {
        initialProps: {
          paused: false,
          targets: [
            { id: "mira", content: live("Reading a.md") },
            { id: "pax", content: live("Editing b.md") },
          ] as AgentStatusLineTarget[],
        },
      },
    );
    expect(result.current.current?.id).toBe("mira");
    rerender({
      paused: true,
      targets: [
        { id: "mira", content: live("Reading a.md") },
        { id: "pax", content: live("Editing b.md") },
      ],
    });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
