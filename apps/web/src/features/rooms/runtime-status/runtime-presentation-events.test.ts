import { describe, expect, it } from "vitest";

import type { TeamHubRuntimePresentationEventRecord } from "@/features/teamhub/teamhub-types";

import { projectRuntimeChatPresentation } from "./runtime-presentation-events";

describe("Runtime presentation events", () => {
  it("restores queued status from persisted events and clears it when execution starts", () => {
    const queued = statusRecord("1", "queued");
    expect(projectRuntimeChatPresentation([queued]).items).toEqual([
      expect.objectContaining({ status: "queued" }),
    ]);
    expect(
      projectRuntimeChatPresentation([queued, statusRecord("2", "working")])
        .items,
    ).toEqual([expect.objectContaining({ status: "working" })]);
    expect(
      projectRuntimeChatPresentation([queued, statusRecord("2", "working")])
        .items[0],
    ).not.toHaveProperty("title");
  });

  it("projects status and formal Messages in durable ordinal order", () => {
    const presentation = projectRuntimeChatPresentation([
      statusRecord("1", "working", undefined, "segment-1"),
      planRecord("2", "segment-1"),
      outputRecord("3", "segment-1", "message-1"),
      statusRecord("4", "thinking", "Inspecting runtime status", "segment-2"),
      outputRecord("5", "segment-2", "message-2"),
    ]);

    expect(presentation.items).toEqual([
      {
        key: "segment-1",
        plan: {
          explanation: "private plan detail",
          steps: [{ content: "private step", status: "in_progress" }],
        },
        outputs: [
          {
            kind: "message",
            outputId: "message-1",
          },
        ],
        segmentId: "segment-1",
        status: "working",
        type: "status",
      },
      {
        key: "output:segment-1:message-1",
        messageId: "message-1",
        segmentId: "segment-1",
        type: "message",
      },
      {
        key: "segment-2",
        marks: [
          {
            key: "thinking:4",
            title: "Inspecting runtime status",
            type: "thinking",
          },
        ],
        plan: {
          explanation: "private plan detail",
          steps: [{ content: "private step", status: "in_progress" }],
        },
        outputs: [
          {
            kind: "message",
            outputId: "message-2",
          },
        ],
        segmentId: "segment-2",
        status: "thinking",
        title: "Inspecting runtime status",
        type: "status",
      },
      {
        key: "output:segment-2:message-2",
        messageId: "message-2",
        segmentId: "segment-2",
        type: "message",
      },
    ]);
    expect(presentation.currentStatus).toBe("thinking");
    expect(presentation.currentTitle).toBe("Inspecting runtime status");
  });

  it("suppresses stopped status and renders a repeated Message once", () => {
    const presentation = projectRuntimeChatPresentation([
      statusRecord("1", "working", undefined, "segment-1"),
      outputRecord("2", "segment-1", "message-1"),
      statusRecord("3", "thinking", undefined, "segment-2"),
      outputRecord("4", "segment-2", "message-1"),
      stoppedRecord("5", "segment-3"),
    ]);

    expect(presentation.items).toEqual([
      {
        key: "segment-1",
        outputs: [
          {
            kind: "message",
            outputId: "message-1",
          },
        ],
        segmentId: "segment-1",
        status: "working",
        type: "status",
      },
      {
        key: "output:segment-1:message-1",
        messageId: "message-1",
        segmentId: "segment-1",
        type: "message",
      },
      {
        key: "segment-2",
        marks: [{ key: "thinking:3", type: "thinking" }],
        outputs: [
          {
            kind: "message",
            outputId: "message-1",
          },
        ],
        segmentId: "segment-2",
        status: "thinking",
        type: "status",
      },
      {
        key: "segment-3",
        segmentId: "segment-3",
        status: "thinking",
        terminalOutcome: "completed",
        type: "status",
      },
    ]);
    expect(presentation.currentStatus).toBeUndefined();
    expect(presentation.currentTitle).toBeUndefined();
  });

  it("keeps one activity identity across a Message segment boundary", () => {
    const presentation = projectRuntimeChatPresentation([
      statusRecord("1", "working", undefined, "segment-1"),
      activityStartedRecord(
        "2",
        "activity-1",
        "tool",
        "Using Send Message",
        "segment-1",
      ),
      activityUpdatedRecord(
        "3",
        "activity-1",
        "Publishing the answer",
        "segment-1",
      ),
      outputRecord("4", "segment-1", "message-1"),
      activityFinishedRecord("5", "activity-1", "succeeded", "segment-2"),
      activityStartedRecord(
        "6",
        "activity-2",
        "response",
        "Composing a response",
        "segment-2",
      ),
    ]);

    expect(presentation.items).toEqual([
      {
        activities: [
          {
            activityId: "activity-1",
            detail: "Publishing the answer",
            entries: [{ detail: "Publishing the answer", type: "progress" }],
            kind: "tool",
            title: "Using Send Message",
          },
        ],
        key: "segment-1",
        marks: [{ activityId: "activity-1", type: "activity" }],
        outputs: [
          {
            kind: "message",
            outputId: "message-1",
          },
        ],
        segmentId: "segment-1",
        status: "working",
        type: "status",
      },
      {
        key: "output:segment-1:message-1",
        messageId: "message-1",
        segmentId: "segment-1",
        type: "message",
      },
      {
        activities: [
          {
            activityId: "activity-1",
            detail: "Publishing the answer",
            entries: [{ detail: "Publishing the answer", type: "progress" }],
            kind: "tool",
            outcome: "succeeded",
            title: "Using Send Message",
          },
          {
            activityId: "activity-2",
            kind: "response",
            title: "Composing a response",
          },
        ],
        key: "segment-2",
        marks: [{ activityId: "activity-2", type: "activity" }],
        segmentId: "segment-2",
        status: "working",
        type: "status",
      },
    ]);
  });

  it("keeps concrete activity content and progress in event order", () => {
    const presentation = projectRuntimeChatPresentation([
      statusRecord("1", "working"),
      activityStartedRecord(
        "2",
        "activity-command",
        "command",
        "Running a command",
        "segment-1",
        [{ content: "pnpm test", format: "code", label: "Command" }],
      ),
      activityUpdatedRecord(
        "3",
        "activity-command",
        "Running Web tests",
        "segment-1",
      ),
      activityFinishedRecord(
        "4",
        "activity-command",
        "succeeded",
        "segment-1",
        [{ content: "43 tests passed", format: "text", label: "Result" }],
      ),
    ]);

    expect(presentation.items[0]).toMatchObject({
      activities: [
        {
          activityId: "activity-command",
          entries: [
            {
              block: {
                content: "pnpm test",
                format: "code",
                label: "Command",
              },
              type: "content",
            },
            { detail: "Running Web tests", type: "progress" },
            {
              block: {
                content: "43 tests passed",
                format: "text",
                label: "Result",
              },
              type: "content",
            },
          ],
          outcome: "succeeded",
        },
      ],
    });
  });
});

function statusRecord(
  eventOrdinal: string,
  status: "queued" | "working" | "thinking",
  title?: string,
  segmentId = "segment-1",
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      status,
      ...(title === undefined ? {} : { title }),
      type: "status.changed",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

function stoppedRecord(
  eventOrdinal: string,
  segmentId: string,
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      outcome: "completed",
      status: "stopped",
      type: "status.changed",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

function planRecord(
  eventOrdinal: string,
  segmentId: string,
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      explanation: "private plan detail",
      steps: [{ content: "private step", status: "in_progress" }],
      type: "plan.updated",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

function outputRecord(
  eventOrdinal: string,
  segmentId: string,
  messageId: string,
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      output_id: messageId,
      output_kind: "message",
      surface: "room_timeline",
      type: "presentation.output_created",
    },
    event_ordinal: eventOrdinal,
    message_id: messageId,
    segment_id: segmentId,
  };
}

function activityStartedRecord(
  eventOrdinal: string,
  activityId: string,
  kind: "command" | "tool" | "response",
  title: string,
  segmentId: string,
  content?: NonNullable<
    Extract<
      TeamHubRuntimePresentationEventRecord["event"],
      { type: "activity.started" }
    >["content"]
  >,
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      activity_id: activityId,
      ...(content === undefined ? {} : { content }),
      kind,
      title,
      type: "activity.started",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

function activityUpdatedRecord(
  eventOrdinal: string,
  activityId: string,
  detail: string,
  segmentId: string,
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      activity_id: activityId,
      detail,
      type: "activity.updated",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

function activityFinishedRecord(
  eventOrdinal: string,
  activityId: string,
  outcome: "succeeded",
  segmentId: string,
  content?: NonNullable<
    Extract<
      TeamHubRuntimePresentationEventRecord["event"],
      { type: "activity.finished" }
    >["content"]
  >,
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      activity_id: activityId,
      ...(content === undefined ? {} : { content }),
      outcome,
      type: "activity.finished",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

it("preserves unconfirmed follow-up evidence on a successful terminal event", () => {
  const result = projectRuntimeChatPresentation([
    {
      event_ordinal: "1",
      segment_id: "segment-follow-up",
      event: {
        type: "status.changed",
        status: "stopped",
        outcome: "completed",
        unconfirmed_input_ids: ["input-follow-up"],
      },
    },
  ]);
  expect(result.currentStatus).toBeUndefined();
  expect(result.items[0]).toMatchObject({
    terminalOutcome: "completed",
    unconfirmedInputIds: ["input-follow-up"],
  });
});
