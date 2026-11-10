import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TeamHubMessageActivityRecord } from "@/features/teamhub/teamhub-types";

import { RuntimeHistoryView } from "./runtime-history-view";

describe("RuntimeHistoryView", () => {
  it("shows the user message by default in the activity timeline", () => {
    const records = [
      claudeRecord(0, "message", {
        native_type: "user",
        role: "user",
        native_record: {
          type: "user",
          message: { role: "user", content: "Please inspect the Room" },
        },
      }),
      claudeRecord(1, "reasoning", {
        native_type: "event_msg.agent_reasoning",
        native_record: {
          payload: { text: "Inspecting Room context" },
          type: "event_msg",
        },
      }),
    ] satisfies TeamHubMessageActivityRecord[];

    const { container } = render(<RuntimeHistoryView records={records} />);

    const userMessage = screen.getByText("Please inspect the Room");
    expect(userMessage).toBeVisible();
    expect(userMessage.closest("details")).toBeNull();
    expect(screen.getByText("Inspecting Room context")).toBeVisible();
    expect(screen.queryByText("Recorded data")).not.toBeInTheDocument();
    expect(container.querySelector('[aria-label="Activity log"]')).toHaveClass(
      "bg-white",
    );
  });

  it("groups native tool names without dumping input or output", () => {
    const records = [
      claudeRecord(0, "tool_call", {
        native_type: "assistant.tool_use",
        role: "assistant",
        tool_call_id: "tool-read",
        tool_name: "Read",
        native_record: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-read",
                name: "Read",
                input: { file_path: "/workspace/README.md" },
              },
            ],
          },
        },
      }),
      claudeRecord(1, "tool_result", {
        native_type: "user.tool_result",
        role: "user",
        tool_call_id: "tool-read",
        tool_name: "Read",
        native_record: {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-read",
                content: "README contents",
              },
            ],
          },
        },
      }),
      claudeRecord(2, "tool_call", {
        native_type: "assistant.tool_use",
        role: "assistant",
        tool_call_id: "tool-search",
        tool_name: "Search",
        native_record: { type: "assistant" },
      }),
    ] satisfies TeamHubMessageActivityRecord[];

    render(<RuntimeHistoryView records={records} />);

    fireEvent.click(screen.getByText("Working through 2 steps"));
    expect(screen.getByText("Read")).toBeVisible();
    expect(screen.getByText("Search")).toBeVisible();
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
    expect(screen.queryByText("Output")).not.toBeInTheDocument();
    expect(screen.queryByText("README contents")).not.toBeInTheDocument();
  });

  it("shows native tool names, not their arguments, in activity history", () => {
    const tools = [
      ["exec_command", { cmd: "rg needle src" }],
      ["exec_command", { cmd: "cat README.md" }],
      ["send_message", {}],
    ] as const;
    const records = tools.map(([name, args], ordinal) =>
      claudeRecord(ordinal, "tool_call", {
        tool_name: name,
        tool_call_id: `call-${ordinal}`,
        native_type: "response_item.function_call",
        native_record: { payload: { name, arguments: JSON.stringify(args) } },
      }),
    );
    render(<RuntimeHistoryView records={records} />);
    fireEvent.click(screen.getByText("Working through 3 steps"));
    expect(screen.getAllByText("exec_command")).toHaveLength(2);
    expect(screen.getByText("send_message")).toBeVisible();
    expect(screen.queryByText("rg needle src")).not.toBeInTheDocument();
  });

  it("names native MCP completions by the raw invocation's tool", () => {
    render(
      <RuntimeHistoryView
        records={[
          claudeRecord(0, "provider_event", {
            native_type: "event_msg.mcp_tool_call_end",
            native_record: {
              payload: {
                invocation: {
                  tool: "exec_command",
                  arguments: { cmd: "cat README.md" },
                },
              },
            },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByText("Working on the task"));
    expect(screen.getByText("exec_command")).toBeVisible();
    expect(screen.queryByText(/README/)).not.toBeInTheDocument();
  });

  it("renders Activity response messages as Markdown", () => {
    render(
      <RuntimeHistoryView
        records={[
          claudeRecord(0, "message", {
            native_type: "response_item.message",
            role: "assistant",
            native_record: {
              payload: {
                content: "Check complete: **fixed**.",
                role: "assistant",
              },
              type: "response_item",
            },
          }),
        ]}
      />,
    );

    expect(screen.getByText("fixed").tagName).toBe("STRONG");
  });

  it("includes thinking, reply and every tool from mixed Claude messages", () => {
    render(
      <RuntimeHistoryView
        records={[
          claudeRecord(0, "tool_call", {
            native_type: "assistant.thinking",
            role: "assistant",
            native_record: {
              type: "assistant",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", content_present: true },
                  { type: "text", text: "Ready to **inspect**." },
                  { type: "tool_use", id: "read", name: "Read", input: {} },
                  { type: "tool_use", id: "search", name: "Search", input: {} },
                ],
              },
            },
          }),
        ]}
      />,
    );
    expect(
      screen.getByText("Thinking recorded · private content hidden"),
    ).toBeVisible();
    expect(screen.getByText("inspect").tagName).toBe("STRONG");
    const group = screen.getByText("Working through 2 steps");
    fireEvent.click(group);
    expect(within(group.closest("li")!).getByText("Read")).toBeVisible();
    expect(within(group.closest("li")!).getByText("Search")).toBeVisible();
  });
});

const claudeRecord = (
  ordinal: number,
  category: TeamHubMessageActivityRecord["category"],
  value: Omit<
    TeamHubMessageActivityRecord,
    "ordinal" | "category" | "redacted_fields" | "turn_id"
  >,
): TeamHubMessageActivityRecord => ({
  ordinal,
  category,
  turn_id: "turn-claude",
  redacted_fields: [],
  ...value,
});
