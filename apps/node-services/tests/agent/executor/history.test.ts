import { redactRuntimeHistoryPage } from "../../../src/agent/executor/history.js";
import { describe, expect, it } from "vitest";

describe("Runtime Debug history", () => {
  it("redacts secrets, physical paths, reasoning content, and instructions again", () => {
    const page = redactRuntimeHistoryPage({
      status: "available",
      providerKind: "codex",
      source: "codex_rollout",
      snapshot: {
        id: "snapshot-1",
        threadId: "thread-1",
        capturedAt: "2026-08-24T12:00:00Z",
        recordCount: 1,
        tailState: "clean",
      },
      instructions: {
        status: "available",
        source: "codex_rollout",
        blocks: [
          {
            recordOrdinal: 0,
            recordType: "session_meta",
            field: "base_instructions",
            text: "Bearer exposed /Users/me/.codex/config.toml",
          },
        ],
      },
      records: [
        {
          ordinal: 0,
          category: "reasoning",
          nativeType: "response_item.reasoning",
          nativeRecord: {
            type: "response_item",
            payload: {
              type: "reasoning",
              summary: [{ text: "allowed summary" }],
              content: "private thought",
              authorization: "Bearer exposed",
              "api-key": "also-exposed",
              accessToken: "camel-exposed",
              path: "/Users/me/.codex/sessions/rollout.jsonl",
            },
          },
          redactedFields: [],
        },
      ],
    });

    expect(page.status).toBe("available");
    if (page.status !== "available") return;
    expect(page.instructions.blocks[0]?.text).toContain("[REDACTED]");
    expect(page.instructions.blocks[0]?.text).toContain("[REDACTED_PATH]");
    expect(page.records[0]?.nativeRecord).toEqual({
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ text: "allowed summary" }],
        path: "[REDACTED_PATH]",
        content_present: true,
      },
    });
    expect(page.records[0]?.redactedFields).toEqual(
      expect.arrayContaining([
        { path: "/payload/content", reason: "reasoning_content" },
        { path: "/payload/authorization", reason: "secret" },
        { path: "/payload/api-key", reason: "secret" },
        { path: "/payload/accessToken", reason: "secret" },
        { path: "/payload/path", reason: "physical_path" },
      ]),
    );
  });

  it("preserves ordinary message and tool content during the second pass", () => {
    const page = redactRuntimeHistoryPage({
      status: "available",
      providerKind: "codex",
      source: "codex_rollout",
      snapshot: {
        id: "snapshot-1",
        threadId: "thread-1",
        capturedAt: "2026-08-24T12:00:00Z",
        recordCount: 1,
        tailState: "clean",
      },
      instructions: {
        status: "unavailable",
        source: "codex_rollout",
        reason: "none",
        blocks: [],
      },
      records: [
        {
          ordinal: 0,
          category: "tool_result",
          nativeType: "response_item.custom_tool_call_output",
          nativeRecord: {
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              content: "visible tool output",
            },
          },
          redactedFields: [],
        },
      ],
    });
    expect(page.status).toBe("available");
    if (page.status !== "available") return;
    expect(page.records[0]?.nativeRecord).toMatchObject({
      payload: { content: "visible tool output" },
    });
  });

  it("preserves only exact agent reasoning event text during the second pass", () => {
    const page = redactRuntimeHistoryPage({
      status: "available",
      providerKind: "codex",
      source: "codex_rollout",
      snapshot: {
        id: "snapshot-1",
        threadId: "thread-1",
        capturedAt: "2026-08-24T12:00:00Z",
        recordCount: 1,
        tailState: "clean",
      },
      instructions: {
        status: "unavailable",
        source: "codex_rollout",
        reason: "none",
        blocks: [],
      },
      records: [
        {
          ordinal: 0,
          category: "reasoning",
          nativeType: "event_msg.agent_reasoning",
          nativeRecord: {
            type: "event_msg",
            payload: {
              type: "agent_reasoning",
              text: "Visible event from /Users/me/private/context.txt with Bearer event-secret-token",
            },
          },
          redactedFields: [],
        },
      ],
    });

    expect(page.status).toBe("available");
    if (page.status !== "available") return;
    expect(page.records[0]?.nativeRecord).toMatchObject({
      payload: {
        text: "Visible event from [REDACTED_PATH] with Bearer [REDACTED]",
      },
    });
    expect(page.records[0]?.redactedFields).not.toEqual(
      expect.arrayContaining([
        { path: "/payload/text", reason: "reasoning_content" },
      ]),
    );
  });
});
