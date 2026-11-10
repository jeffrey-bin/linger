import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WikiGraphData, WikiGraphNode } from "./wiki-graph-model";
import { WikiKnowledgeGraph } from "./wiki-knowledge-graph";

function node(
  id: string,
  category: string,
  overrides: Partial<WikiGraphNode> = {},
): WikiGraphNode {
  return {
    id,
    title: id.split("/").at(-1)!,
    category,
    description: "",
    tags: [],
    body: "",
    size: 400,
    links: [],
    backlinks: [],
    ...overrides,
  };
}

const graph: WikiGraphData = {
  types: ["Project", "Session", "Topic"],
  nodes: [
    node("sessions/2026-09-01/capture_session_a", "Session", {
      title: "Kickoff meeting",
    }),
    node("sessions/2026-09-03/capture_session_b", "Session", {
      title: "Review meeting",
    }),
    node("projects/lev8", "Project", {
      title: "Lev8 Outbound",
      backlinks: ["sessions/2026-09-01/capture_session_a"],
      body: "# Lev8 Outbound\n\n## Project Summary\n\nControlled outreach.",
    }),
    node("topics/method", "Topic", { title: "Method" }),
  ],
  edges: [
    {
      source: "sessions/2026-09-01/capture_session_a",
      target: "projects/lev8",
    },
  ],
};

type RenderTimeline = NonNullable<
  Parameters<typeof WikiKnowledgeGraph>[0]["renderTimeline"]
>;

describe("WikiKnowledgeGraph", () => {
  const playhead = () =>
    screen.getByRole("slider", { name: "Timeline playhead" });
  // The timeline runs through today; pin today to the last Session day.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-03T12:00:00+08:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows only the Timeline with Day and Week granularity", () => {
    render(<WikiKnowledgeGraph graph={graph} />);
    expect(
      screen.getAllByRole("radio").map((radio) => radio.textContent),
    ).toEqual(["Day", "Week"]);
    expect(screen.queryByRole("img", { name: "Knowledge graph" })).toBeNull();
    expect(playhead()).toHaveAttribute("aria-valuetext", "SEP 3, 2026");
  });

  it("shows dated events and Sessions without treating Wiki update dates as events", () => {
    render(
      <WikiKnowledgeGraph
        graph={{
          ...graph,
          nodes: graph.nodes.map((item) =>
            item.id === "projects/lev8"
              ? { ...item, body: "## Change Log\n- 2026-09-03 Created." }
              : item,
          ),
          timelineEvents: [
            { id: "event-1", day: "2026-09-03", title: "Product launch" },
          ],
        }}
      />,
    );
    const readout = document.querySelector(".wiki-graph-readout")!;
    expect(readout.textContent).toMatch(/^SEP 3\s*2026$/u);
    expect(readout).not.toHaveTextContent("Product launch");
    expect(readout).not.toHaveTextContent("Lev8 Outbound");
  });

  it("continues to today when nothing was updated since", () => {
    vi.setSystemTime(new Date("2026-09-05T12:00:00+08:00"));
    render(<WikiKnowledgeGraph graph={graph} />);
    expect(playhead()).toHaveAttribute("aria-valuetext", "SEP 5, 2026");
  });

  it("moves the cards with the playhead and returns from Latest", () => {
    const renderTimeline = vi.fn<RenderTimeline>(() => <p>Daily cards</p>);
    render(
      <WikiKnowledgeGraph graph={graph} renderTimeline={renderTimeline} />,
    );
    expect(screen.getByText("Daily cards")).toBeVisible();
    fireEvent.keyDown(playhead(), { key: "Home" });
    expect(playhead()).toHaveAttribute("aria-valuetext", "SEP 1, 2026");
    expect(renderTimeline.mock.calls.at(-1)?.[2].focus?.day).toBe("2026-09-01");
    fireEvent.keyDown(playhead(), { key: "ArrowRight" });
    expect(renderTimeline.mock.calls.at(-1)?.[2].focus?.day).toBe("2026-09-02");
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(playhead()).toHaveAttribute("aria-valuetext", "SEP 3, 2026");
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toHaveAttribute("tabindex", "-1");
  });

  it("follows a browsed card with the playhead", () => {
    let navigate: ((day: string) => void) | undefined;
    render(
      <WikiKnowledgeGraph
        graph={graph}
        renderTimeline={(_pages, _granularity, navigation) => {
          navigate = navigation.onPeriodChange;
          return null;
        }}
      />,
    );
    act(() => navigate?.("2026-09-01"));
    expect(playhead()).toHaveAttribute("aria-valuetext", "SEP 1, 2026");
  });

  it("filters the card pages by search", () => {
    const renderTimeline = vi.fn<RenderTimeline>(() => null);
    render(
      <WikiKnowledgeGraph graph={graph} renderTimeline={renderTimeline} />,
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Search pages" }), {
      target: { value: "lev8" },
    });
    expect(
      renderTimeline.mock.calls.at(-1)?.[0].map((page) => page.id),
    ).toEqual(["projects/lev8"]);
  });

  it("keeps the playhead day when switching to weeks", () => {
    const onReadingModeChange = vi.fn();
    render(
      <WikiKnowledgeGraph
        graph={graph}
        onReadingModeChange={onReadingModeChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(screen.getByRole("radio", { name: "Week" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(playhead()).toHaveAttribute(
      "aria-valuetext",
      "AUG 31 – SEP 6, 2026",
    );
    expect(onReadingModeChange).toHaveBeenCalledOnce();
  });
});
