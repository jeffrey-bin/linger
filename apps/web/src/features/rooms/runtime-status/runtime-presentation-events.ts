import type { TeamHubRuntimePresentationEventRecord } from "@/features/teamhub/teamhub-types";

type RuntimeEvent = TeamHubRuntimePresentationEventRecord["event"];
export type RuntimeExecutionFailure = NonNullable<
  Extract<RuntimeEvent, { status: "stopped" }>["failure"]
>;

export interface RuntimeActivityPresentation {
  activityId: string;
  detail?: string;
  entries?: readonly RuntimeActivityEntry[];
  kind: Extract<RuntimeEvent, { type: "activity.started" }>["kind"];
  outcome?: Extract<RuntimeEvent, { type: "activity.finished" }>["outcome"];
  title: string;
}

export type RuntimeActivityContentBlock = NonNullable<
  Extract<RuntimeEvent, { type: "activity.started" }>["content"]
>[number];

export type RuntimeActivityEntry =
  | { block: RuntimeActivityContentBlock; type: "content" }
  | { detail: string; type: "progress" };

export interface RuntimePlanPresentation {
  explanation?: string;
  steps: Extract<RuntimeEvent, { type: "plan.updated" }>["steps"];
}

/**
 * What the Room status line names, in the order it happened: thinking, with
 * its title when there is one, and each Activity that started.
 */
export type RuntimeStatusMark =
  | { key: string; title?: string; type: "thinking" }
  | { activityId: string; type: "activity" };

export interface RuntimeOutputPresentation {
  kind: Extract<
    RuntimeEvent,
    { type: "presentation.output_created" }
  >["output_kind"];
  outputId: string;
}

export type RuntimeChatPresentationItem =
  | {
      activities?: readonly RuntimeActivityPresentation[];
      key: string;
      marks?: readonly RuntimeStatusMark[];
      outputs?: readonly RuntimeOutputPresentation[];
      plan?: RuntimePlanPresentation;
      segmentId: string;
      status: "queued" | "working" | "thinking";
      terminalOutcome?: "canceled" | "completed" | "failed";
      failure?: RuntimeExecutionFailure;
      unconfirmedInputIds?: readonly string[];
      title?: string;
      type: "status";
    }
  | {
      key: string;
      messageId: string;
      segmentId: string;
      type: "message";
    };

export interface RuntimeChatPresentation {
  currentStatus?: "queued" | "working" | "thinking";
  currentTitle?: string;
  items: readonly RuntimeChatPresentationItem[];
}

type MutableActivity = RuntimeActivityPresentation & {
  readonly activityEntries: RuntimeActivityEntry[];
  readonly startOrdinal: bigint;
};

interface MutableSegment {
  activityIds: Set<string>;
  marks: RuntimeStatusMark[];
  messageId?: string;
  outputs: RuntimeOutputPresentation[];
  plan?: RuntimePlanPresentation;
  segmentId: string;
  status?: "queued" | "working" | "thinking";
  terminalOutcome?: "canceled" | "completed" | "failed";
  failure?: RuntimeExecutionFailure;
  unconfirmedInputIds?: readonly string[];
  title?: string;
}

export function projectRuntimeChatPresentation(
  records: readonly TeamHubRuntimePresentationEventRecord[],
): RuntimeChatPresentation {
  const placedMessageIds = new Set<string>();
  const items: RuntimeChatPresentationItem[] = [];
  const activities = new Map<string, MutableActivity>();
  let currentPlan: RuntimePlanPresentation | undefined;
  let currentStatus: "queued" | "working" | "thinking" | undefined;
  let currentTitle: string | undefined;
  let segment: MutableSegment | undefined;

  const flushSegment = () => {
    if (!segment) return;
    const segmentActivities = [...segment.activityIds]
      .map((activityId) => activities.get(activityId))
      .filter((activity): activity is MutableActivity => Boolean(activity))
      .sort((left, right) =>
        left.startOrdinal < right.startOrdinal
          ? -1
          : left.startOrdinal > right.startOrdinal
            ? 1
            : 0,
      )
      .map((activity) => ({
        activityId: activity.activityId,
        ...(activity.activityEntries.length === 0
          ? {}
          : {
              entries: activity.activityEntries.map((entry) =>
                entry.type === "content"
                  ? { block: { ...entry.block }, type: entry.type }
                  : { ...entry },
              ),
            }),
        ...(activity.detail === undefined ? {} : { detail: activity.detail }),
        kind: activity.kind,
        ...(activity.outcome === undefined
          ? {}
          : { outcome: activity.outcome }),
        title: activity.title,
      }));
    items.push({
      key: segment.segmentId,
      segmentId: segment.segmentId,
      status: segment.status ?? "working",
      ...(segment.title === undefined ? {} : { title: segment.title }),
      ...(segment.failure ? { failure: segment.failure } : {}),
      ...(segment.unconfirmedInputIds?.length
        ? { unconfirmedInputIds: segment.unconfirmedInputIds }
        : {}),
      ...(segment.terminalOutcome === undefined
        ? {}
        : { terminalOutcome: segment.terminalOutcome }),
      ...(segmentActivities.length === 0
        ? {}
        : { activities: segmentActivities }),
      ...(segment.marks.length === 0
        ? {}
        : { marks: segment.marks.map((mark) => ({ ...mark })) }),
      ...(segment.outputs.length === 0
        ? {}
        : { outputs: segment.outputs.map((output) => ({ ...output })) }),
      ...(segment.plan === undefined ? {} : { plan: segment.plan }),
      type: "status",
    });
    if (segment.messageId && !placedMessageIds.has(segment.messageId)) {
      placedMessageIds.add(segment.messageId);
      items.push({
        key: `output:${segment.segmentId}:${segment.messageId}`,
        messageId: segment.messageId,
        segmentId: segment.segmentId,
        type: "message",
      });
    }
    segment = undefined;
  };

  const selectSegment = (record: TeamHubRuntimePresentationEventRecord) => {
    if (segment?.segmentId === record.segment_id) return segment;
    flushSegment();
    segment = {
      activityIds: new Set(
        [...activities.values()]
          .filter((activity) => activity.outcome === undefined)
          .map((activity) => activity.activityId),
      ),
      ...(currentPlan === undefined ? {} : { plan: currentPlan }),
      marks: [],
      outputs: [],
      segmentId: record.segment_id,
      ...(currentStatus === undefined ? {} : { status: currentStatus }),
      ...(currentTitle === undefined ? {} : { title: currentTitle }),
    };
    return segment;
  };

  for (const record of records) {
    const event = record.event;
    const selected = selectSegment(record);
    if (event.type === "status.changed") {
      if (event.status === "stopped") {
        selected.status ??= currentStatus ?? "working";
        selected.title ??= currentTitle;
        selected.terminalOutcome = event.outcome;
        selected.unconfirmedInputIds = event.unconfirmed_input_ids;
        selected.failure =
          event.outcome === "failed" ? event.failure : undefined;
        currentStatus = undefined;
        currentTitle = undefined;
      } else {
        currentStatus = event.status;
        currentTitle = event.status === "working" ? undefined : event.title;
        selected.status = currentStatus;
        selected.title = currentTitle;
        if (event.status === "thinking") {
          selected.marks.push({
            key: `thinking:${record.event_ordinal}`,
            ...(event.title === undefined ? {} : { title: event.title }),
            type: "thinking",
          });
        }
      }
      continue;
    }
    if (event.type === "plan.updated") {
      currentPlan = {
        ...(event.explanation === undefined
          ? {}
          : { explanation: event.explanation }),
        steps: event.steps.map((step) => ({ ...step })),
      };
      selected.plan = currentPlan;
      continue;
    }
    if (event.type === "activity.started") {
      activities.set(event.activity_id, {
        activityEntries:
          event.content?.map((block) => ({
            block: { ...block },
            type: "content" as const,
          })) ?? [],
        activityId: event.activity_id,
        kind: event.kind,
        startOrdinal: BigInt(record.event_ordinal),
        title: event.title,
      });
      selected.activityIds.add(event.activity_id);
      selected.marks.push({ activityId: event.activity_id, type: "activity" });
      continue;
    }
    if (event.type === "activity.updated") {
      const activity = activities.get(event.activity_id);
      if (activity) {
        activity.detail = event.detail;
        const latestEntry = activity.activityEntries.at(-1);
        if (
          latestEntry?.type !== "progress" ||
          latestEntry.detail !== event.detail
        ) {
          activity.activityEntries.push({
            detail: event.detail,
            type: "progress",
          });
        }
      }
      selected.activityIds.add(event.activity_id);
      continue;
    }
    if (event.type === "activity.finished") {
      const activity = activities.get(event.activity_id);
      if (activity) {
        activity.outcome = event.outcome;
        if (event.content) {
          activity.activityEntries.push(
            ...event.content.map((block) => ({
              block: { ...block },
              type: "content" as const,
            })),
          );
        }
      }
      selected.activityIds.add(event.activity_id);
      continue;
    }
    if (event.type === "presentation.output_created") {
      selected.outputs.push({
        kind: event.output_kind,
        outputId: event.output_id,
      });
      if (record.message_id) selected.messageId ??= record.message_id;
    }
  }

  flushSegment();
  return {
    ...(currentStatus === undefined ? {} : { currentStatus }),
    ...(currentTitle === undefined ? {} : { currentTitle }),
    items,
  };
}
