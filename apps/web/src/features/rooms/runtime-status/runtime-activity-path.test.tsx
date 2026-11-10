import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TeamHubMessage,
  TeamHubRuntimePresentationEventRecord,
} from "@/features/teamhub/teamhub-types";

import { projectRuntimeActivityPath } from "./runtime-activity-path";
import { RuntimeActivityPath } from "./runtime-activity-path-view";

describe("Runtime activity path", () => {
  it.each(["ended", "interrupted", "paused"] as const)(
    "stops unfinished tool and plan spinners when the Run Status is %s",
    (lifecycle) => {
      const records = [
        record("1", {
          type: "activity.started",
          activity_id: "command",
          kind: "command",
          title: "Checking workspace",
        }),
        record("2", {
          type: "plan.updated",
          steps: [{ content: "Review", status: "in_progress" }],
        }),
      ];
      const items = projectRuntimeActivityPath(records, new Map(), lifecycle);
      expect(items[0]).toMatchObject({ active: false, unconfirmed: true });
      expect(items[1]).toMatchObject({ steps: [{ status: "pending" }] });
      render(
        <RuntimeActivityPath
          records={records}
          lifecycle={lifecycle}
          embedded
        />,
      );
      expect(screen.queryByLabelText("In progress")).toBeNull();
      expect(screen.getByText("Unconfirmed")).toBeVisible();
    },
  );
  it("positions the viewport at the bottom of the latest activity, including a tall last entry", async () => {
    render(
      <RuntimeActivityPath
        records={[
          record("latest", {
            status: "thinking",
            title: "Latest activity",
            type: "status.changed",
          }),
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Activity log" });
    expect(list.querySelector(".runtime-activity-step")).not.toBeNull();
    Object.defineProperties(list, {
      scrollHeight: { value: 1800 },
      clientHeight: { value: 400 },
    });
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo;
    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ top: 1400 }),
      ),
    );
  });

  it("shows the current plan and recent activity before older steps", () => {
    render(
      <RuntimeActivityPath
        records={[
          record("plan", {
            explanation: "Start with the highest-priority work",
            steps: [{ content: "Review the request", status: "in_progress" }],
            type: "plan.updated",
          }),
          ...Array.from({ length: 10 }, (_, index) =>
            record(String(index + 1), {
              status: "thinking" as const,
              title: `Activity ${index + 1}`,
              type: "status.changed" as const,
            }),
          ),
        ]}
      />,
    );

    expect(screen.getByText("Plan")).toBeVisible();
    expect(screen.getByText("Review the request")).toBeVisible();
    expect(screen.queryByText("Activity 1")).not.toBeInTheDocument();
    expect(screen.getByText("Activity 10")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Show all activity (2 more)" }),
    );
    expect(screen.getByText("Activity 1")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Show less activity" }),
    ).toBeVisible();
  });

  it("omits intermediate updates, old replies, and repeated operations by default", () => {
    render(
      <RuntimeActivityPath
        messages={[
          {
            id: "reply-1",
            raw_message: "First reply",
          } as TeamHubMessage,
          {
            id: "reply-2",
            raw_message: "Final reply",
          } as TeamHubMessage,
        ]}
        records={[
          record("1", {
            activity_id: "send-1",
            kind: "message",
            title: "Bash",
            type: "activity.started",
          }),
          record("2", {
            output_id: "reply-1",
            output_kind: "message",
            surface: "room_timeline",
            type: "presentation.output_created",
          }),
          record("3", {
            activity_id: "command-1",
            kind: "command",
            title: "Running a command",
            type: "activity.started",
          }),
          record("4", {
            activity_id: "command-2",
            kind: "command",
            title: "Running a command",
            type: "activity.started",
          }),
          record("5", {
            output_id: "reply-2",
            output_kind: "message",
            surface: "room_timeline",
            type: "presentation.output_created",
          }),
        ]}
      />,
    );

    expect(screen.queryByText("Sending an update")).not.toBeInTheDocument();
    expect(screen.getAllByText("Running a command")).toHaveLength(1);
    expect(screen.getAllByText("Prepared a reply")).toHaveLength(1);
    expect(screen.getByText("Final reply")).not.toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Show all activity (3 more)" }),
    );
    expect(screen.getAllByText("Sending an update")).toHaveLength(2);
    expect(screen.getAllByText("Running a command")).toHaveLength(2);
    expect(screen.getAllByText("Prepared a reply")).toHaveLength(2);
  });

  it("uses the same operation summaries and icons for live tools", () => {
    render(
      <RuntimeActivityPath
        records={[
          record("1", {
            type: "activity.started",
            activity_id: "read",
            kind: "read",
            title: "Read",
          }),
          record("2", {
            type: "activity.started",
            activity_id: "command",
            kind: "search",
            title: "exec_command",
            content: [
              {
                format: "json",
                label: "Input",
                content: JSON.stringify({ cmd: "rg needle src" }),
              },
            ],
          }),
          record("3", {
            type: "activity.started",
            activity_id: "message",
            kind: "message",
            title: "Bash",
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByText("Working through 3 steps"));
    const glyphs = ["Read file", "Search", "Message"].map(
      (label) => screen.getByLabelText(label).querySelector("svg")?.innerHTML,
    );
    expect(glyphs.every(Boolean)).toBe(true);
    expect(new Set(glyphs).size).toBe(3);
  });

  it.each([
    {
      title: "exec_command",
      kind: "command" as const,
      content: {
        label: "Input",
        format: "json" as const,
        content: JSON.stringify({ cmd: "git status --short" }),
      },
    },
    {
      title: "Running a command",
      kind: "command" as const,
      content: {
        label: "Command",
        format: "code" as const,
        content: "git status --short",
      },
    },
  ])(
    "keeps the concrete command behind the $title technical disclosure",
    ({ title, content }) => {
      render(
        <RuntimeActivityPath
          records={[
            record("1", {
              type: "activity.started",
              activity_id: "cmd",
              title,
              kind: "command",
              content: [content],
            }),
          ]}
        />,
      );
      const group = screen.getAllByText("Running a command")[0]!;
      expect(group).toBeVisible();
      const technicalCommand = screen.getByText(/git status --short/);
      expect(technicalCommand).not.toBeVisible();
      fireEvent.click(group);
      expect(technicalCommand).toBeVisible();
      expect(screen.queryByText("exec_command")).not.toBeInTheDocument();
    },
  );

  let contentHeight = 96;
  const observers = new Map<Element, ResizeObserverCallback>();

  function resizeContent(height: number) {
    contentHeight = height;
    for (const [target, callback] of observers) {
      callback(
        [
          {
            target,
            contentRect: { height, width: 320 },
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    }
  }

  beforeEach(() => {
    contentHeight = 96;
    observers.clear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          observers.set(target, this.callback);
          resizeContent(contentHeight);
        }
        disconnect() {
          for (const [target, callback] of observers) {
            if (callback === this.callback) observers.delete(target);
          }
        }
        unobserve(target: Element) {
          observers.delete(target);
        }
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows each public thinking title and skips response composition", () => {
    const items = projectRuntimeActivityPath([
      record("1", {
        type: "status.changed",
        status: "thinking",
        title: "Plan the reply",
      }),
      record("2", {
        type: "activity.started",
        activity_id: "search-1",
        kind: "search",
        title: "Reviewing release risks",
      }),
      record("3", {
        type: "activity.started",
        activity_id: "tool-1",
        kind: "tool",
        title: "get_room",
      }),
      record("4", {
        type: "activity.started",
        activity_id: "reply-1",
        kind: "response",
        title: "Composing a response",
        content: [
          {
            content: "Generating response text",
            format: "text",
            label: "Progress",
          },
        ],
      }),
    ]);

    expect(items).toEqual([
      {
        active: false,
        kind: "thinking",
        key: "thinking:1",
        title: "Plan the reply",
      },
      {
        calls: [
          {
            active: true,
            entries: [],
            id: "search-1",
            kind: "search",
            name: "Reviewing release risks",
          },
          {
            active: true,
            entries: [],
            id: "tool-1",
            kind: "tool",
            name: "get_room",
          },
        ],
        kind: "tool_calls",
        key: "tools:search-1",
      },
    ]);
    expect(JSON.stringify(items)).not.toContain("Composing a response");
  });

  it("omits thinking with no public title", () => {
    expect(
      projectRuntimeActivityPath([
        record("1", { type: "status.changed", status: "thinking" }),
        record("2", {
          type: "activity.started",
          activity_id: "tool-1",
          kind: "tool",
          title: "get_room",
        }),
      ]),
    ).toEqual([
      {
        calls: [
          {
            active: true,
            entries: [],
            id: "tool-1",
            kind: "tool",
            name: "get_room",
          },
        ],
        kind: "tool_calls",
        key: "tools:tool-1",
      },
    ]);
  });

  it("renders a streaming path instead of command instruction blocks", async () => {
    render(
      <RuntimeActivityPath
        records={[
          record("1", {
            type: "status.changed",
            status: "thinking",
            title: "Check the Room members first",
          }),
          record("2", {
            type: "activity.started",
            activity_id: "command-1",
            content: [
              {
                content: "/bin/zsh -lc 'cat ~/.env'",
                format: "code",
                label: "COMMAND",
              },
            ],
            kind: "command",
            title: "Running a command",
          }),
          record("3", {
            type: "activity.started",
            activity_id: "tool-1",
            content: [
              { content: '{"id":"room"}', format: "json", label: "Input" },
            ],
            kind: "tool",
            title: "get_room",
          }),
          record("4", {
            type: "activity.started",
            activity_id: "tool-2",
            kind: "tool",
            title: "list_members",
          }),
        ]}
      />,
    );

    expect(screen.getByRole("list", { name: "Activity log" })).toBeVisible();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(
      await screen.findByText("Check the Room members first"),
    ).toBeVisible();
    expect(screen.getByText("Running a command")).toBeVisible();
    expect(screen.getByText("/bin/zsh -lc 'cat ~/.env'")).not.toBeVisible();
    expect(screen.getByText("Working through 2 steps")).toBeVisible();
    expect(screen.getByText("COMMAND").closest("details")).not.toHaveAttribute(
      "open",
    );
    expect(screen.queryByText("Current activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Working through 2 steps"));
    expect(screen.getAllByText("Working on the task")).toHaveLength(2);
    expect(screen.getByText("Input").closest("details")).not.toHaveAttribute(
      "open",
    );

    fireEvent.click(screen.getAllByText("Working on the task")[0]!);
    expect(screen.getByText("Input").closest("details")).toHaveAttribute(
      "open",
      "",
    );
  });

  it("folds long thinking and keeps replies collapsed until selected", async () => {
    const title = "Synthesize a six-week launch plan. ".repeat(4).trim();
    const reply = "Final conclusion.".repeat(40);
    render(
      <RuntimeActivityPath
        messages={[
          {
            id: "message-1",
            raw_message: reply,
          } as TeamHubMessage,
        ]}
        records={[
          record("1", {
            status: "thinking",
            title,
            type: "status.changed",
          }),
          record("2", {
            output_id: "message-1",
            output_kind: "message",
            surface: "room_timeline",
            type: "presentation.output_created",
          }),
        ]}
      />,
    );

    const toggles = await screen.findAllByRole("button", { name: "Show more" });
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
    expect(toggles[0]).toHaveAttribute("aria-controls");
    expect(toggles[0]?.closest("li")?.textContent).toContain(
      "Synthesize a six-week launch plan",
    );

    fireEvent.click(toggles[0]!);
    const collapsed = () =>
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-expanded="true"]',
      );
    expect(collapsed()).toHaveLength(1);
    expect(collapsed()[0]).toHaveAttribute("aria-expanded", "true");
    expect(collapsed()[0]?.closest("li")?.textContent).toContain(title);

    expect(screen.getByText(reply)).not.toBeVisible();
    fireEvent.click(screen.getByText("Prepared a reply"));
    expect(screen.getByText(reply)).toBeVisible();
  });

  it("expands short multiline content based on height and updates after resize", async () => {
    const title = "First line\nSecond line\nThird line";
    render(
      <RuntimeActivityPath
        records={[
          record("1", {
            status: "thinking",
            title,
            type: "status.changed",
          }),
        ]}
      />,
    );

    const toggle = await screen.findByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const contentId = toggle.getAttribute("aria-controls")!;
    expect(document.getElementById(contentId)).toHaveTextContent("Third line");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    await act(async () => {
      resizeContent(20);
      await new Promise(requestAnimationFrame);
    });
    expect(
      screen.queryByRole("button", { name: "Show more" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      resizeContent(96);
      await new Promise(requestAnimationFrame);
    });
    expect(
      await screen.findByRole("button", { name: "Show more" }),
    ).toBeVisible();
  });

  it("does not offer expansion for text that fits, regardless of character count", () => {
    contentHeight = 20;
    render(
      <RuntimeActivityPath
        records={[
          record("1", {
            status: "thinking",
            title: "i".repeat(80),
            type: "status.changed",
          }),
        ]}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows all Markdown response paragraphs and list items without clipping", () => {
    const body = "**Done**\n\n- First item\n- Second item\n- Third item";
    render(
      <RuntimeActivityPath
        messages={[{ id: "short-reply", raw_message: body } as TeamHubMessage]}
        records={[
          record("1", {
            type: "presentation.output_created",
            output_kind: "message",
            output_id: "short-reply",
            surface: "room_timeline",
          }),
        ]}
      />,
    );
    expect(screen.getByText("Done")).not.toBeVisible();
    fireEvent.click(screen.getByText("Prepared a reply"));
    expect(screen.getByText("Done").tagName).toBe("STRONG");
    expect(screen.getByText("Third item").tagName).toBe("LI");
    expect(
      screen.queryByRole("button", { name: "Show more" }),
    ).not.toBeInTheDocument();
  });

  it("renders the response entry with the shared Markdown message renderer", async () => {
    render(
      <RuntimeActivityPath
        messages={[
          {
            id: "message-markdown",
            raw_message: "Check complete: **fixed**.",
          } as TeamHubMessage,
        ]}
        records={[
          record("1", {
            output_id: "message-markdown",
            output_kind: "message",
            surface: "room_timeline",
            type: "presentation.output_created",
          }),
        ]}
      />,
    );

    expect(screen.getByText("fixed")).not.toBeVisible();
    fireEvent.click(screen.getByText("Prepared a reply"));
    expect(screen.getByText("fixed").tagName).toBe("STRONG");
  });

  it("keeps thinking text after later working and command events", () => {
    const items = projectRuntimeActivityPath([
      record("1", {
        type: "status.changed",
        status: "thinking",
        title: "Inspect the previous peer skill and current runtime settings",
      }),
      record("2", { type: "status.changed", status: "working" }),
      record("3", {
        type: "activity.started",
        activity_id: "command-1",
        content: [
          {
            content: "/bin/zsh -lc 'cat .agents/skills/agent-worker/SKILL.md'",
            format: "code",
            label: "COMMAND",
          },
        ],
        kind: "command",
        title: "Running a command",
      }),
      record("4", { type: "status.changed", status: "working" }),
      record("5", {
        type: "activity.started",
        activity_id: "command-2",
        content: [
          {
            content: "/bin/zsh -lc 'cat playground/agent.json'",
            format: "code",
            label: "COMMAND",
          },
        ],
        kind: "command",
        title: "Running a command",
      }),
      record("6", {
        type: "status.changed",
        status: "thinking",
        title: "Next I will search matching skills",
      }),
      record("7", {
        type: "activity.started",
        activity_id: "tool-1",
        kind: "tool",
        title: "skill_search",
      }),
    ]);

    expect(items).toEqual([
      {
        active: false,
        kind: "thinking",
        key: "thinking:1",
        title: "Inspect the previous peer skill and current runtime settings",
      },
      {
        active: true,
        entries: [
          {
            block: {
              content:
                "/bin/zsh -lc 'cat .agents/skills/agent-worker/SKILL.md'",
              format: "code",
              label: "COMMAND",
            },
            type: "content",
          },
        ],
        key: "command-1",
        kind: "command",
        name: "/bin/zsh -lc 'cat .agents/skills/agent-worker/SKILL.md'",
      },
      {
        active: true,
        entries: [
          {
            block: {
              content: "/bin/zsh -lc 'cat playground/agent.json'",
              format: "code",
              label: "COMMAND",
            },
            type: "content",
          },
        ],
        key: "command-2",
        kind: "command",
        name: "/bin/zsh -lc 'cat playground/agent.json'",
      },
      {
        active: false,
        kind: "thinking",
        key: "thinking:6",
        title: "Next I will search matching skills",
      },
      {
        calls: [
          {
            active: true,
            entries: [],
            id: "tool-1",
            kind: "tool",
            name: "skill_search",
          },
        ],
        kind: "tool_calls",
        key: "tools:tool-1",
      },
    ]);
  });

  it("keeps every distinct thinking title from status changes", () => {
    expect(
      projectRuntimeActivityPath([
        record("1", {
          status: "thinking",
          title: "First look at the files",
          type: "status.changed",
        }),
        record("2", {
          status: "thinking",
          title: "The schema does not match the form",
          type: "status.changed",
        }),
        record("3", {
          status: "queued",
          title: "Waiting for the Room",
          type: "status.changed",
        }),
      ]).map((item) => (item.kind === "thinking" ? item.title : item.kind)),
    ).toEqual([
      "First look at the files",
      "The schema does not match the form",
      "Waiting for the Room",
    ]);
  });

  it("keeps command output, tool results, plan steps, and the published reply", () => {
    const items = projectRuntimeActivityPath(
      [
        record("1", {
          explanation: "Check the room, then reply",
          steps: [{ content: "Read members", status: "in_progress" }],
          type: "plan.updated",
        }),
        record("2", {
          activity_id: "command-1",
          content: [{ content: "pwd", format: "code", label: "Command" }],
          kind: "command",
          title: "Running a command",
          type: "activity.started",
        }),
        record("3", {
          activity_id: "command-1",
          content: [{ content: "/repo", format: "code", label: "Output" }],
          outcome: "succeeded",
          type: "activity.finished",
        }),
        record("4", {
          activity_id: "tool-1",
          content: [{ content: "{}", format: "json", label: "Input" }],
          kind: "tool",
          title: "get_room",
          type: "activity.started",
        }),
        record("5", {
          activity_id: "tool-1",
          detail: "Reading members",
          type: "activity.updated",
        }),
        record("6", {
          activity_id: "tool-1",
          content: [
            { content: '{"ok":true}', format: "json", label: "Result" },
          ],
          outcome: "failed",
          type: "activity.finished",
        }),
        record("7", {
          output_id: "message-1",
          output_kind: "message",
          surface: "room_timeline",
          type: "presentation.output_created",
        }),
      ],
      new Map([["message-1", "The Room has two members."]]),
    );

    expect(items).toEqual([
      {
        explanation: "Check the room, then reply",
        key: "plan",
        kind: "plan",
        steps: [{ content: "Read members", status: "in_progress" }],
      },
      {
        active: false,
        entries: [
          {
            block: { content: "pwd", format: "code", label: "Command" },
            type: "content",
          },
          {
            block: { content: "/repo", format: "code", label: "Output" },
            type: "content",
          },
        ],
        key: "command-1",
        kind: "command",
        name: "pwd",
        outcome: "succeeded",
      },
      {
        calls: [
          {
            active: false,
            entries: [
              {
                block: { content: "{}", format: "json", label: "Input" },
                type: "content",
              },
              { detail: "Reading members", type: "progress" },
              {
                block: {
                  content: '{"ok":true}',
                  format: "json",
                  label: "Result",
                },
                type: "content",
              },
            ],
            id: "tool-1",
            kind: "tool",
            name: "get_room",
            outcome: "failed",
          },
        ],
        key: "tools:tool-1",
        kind: "tool_calls",
      },
      {
        key: "reply:message-1",
        kind: "reply",
        text: "The Room has two members.",
      },
    ]);
  });
});

function record(
  eventOrdinal: string,
  event: TeamHubRuntimePresentationEventRecord["event"],
): TeamHubRuntimePresentationEventRecord {
  return {
    event,
    event_ordinal: eventOrdinal,
    segment_id: "segment-1",
  };
}
