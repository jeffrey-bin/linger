import type { TeamHubRuntimePresentationEventRecord } from "@/features/teamhub/teamhub-types";

import { runtimeFailureMessage } from "./runtime-failure-message";
import {
  projectRuntimeChatPresentation,
  type RuntimeActivityEntry,
  type RuntimeActivityPresentation,
  type RuntimePlanPresentation,
} from "./runtime-presentation-events";

export type RuntimeActivityLifecycle =
  | "active"
  | "ended"
  | "interrupted"
  | "paused";

type ActivityOutcome = NonNullable<RuntimeActivityPresentation["outcome"]>;

export type RuntimeActivityPathItem =
  | {
      active: boolean;
      kind: "thinking";
      key: string;
      title: string;
    }
  | {
      active: boolean;
      entries: readonly RuntimeActivityEntry[];
      key: string;
      kind: "command";
      name: string;
      outcome?: ActivityOutcome;
      unconfirmed?: boolean;
    }
  | {
      active: boolean;
      activityKind: "interaction";
      entries: readonly RuntimeActivityEntry[];
      key: string;
      kind: "activity";
      outcome?: ActivityOutcome;
      unconfirmed?: boolean;
      title: string;
    }
  | {
      calls: readonly RuntimeActivityPathToolCall[];
      kind: "tool_calls";
      key: string;
    }
  | {
      explanation?: string;
      key: string;
      kind: "plan";
      steps: RuntimePlanPresentation["steps"];
    }
  | {
      key: string;
      kind: "reply";
      text: string;
    }
  | {
      kind: "outcome";
      key: string;
      text: string;
      tone: "canceled" | "failed";
    };

export interface RuntimeActivityPathToolCall {
  active: boolean;
  entries: readonly RuntimeActivityEntry[];
  id: string;
  kind: RuntimeActivityPresentation["kind"];
  name: string;
  outcome?: ActivityOutcome;
  unconfirmed?: boolean;
}

const TOOL_KINDS = new Set<RuntimeActivityPresentation["kind"]>([
  "browse",
  "delegation",
  "file_change",
  "image",
  "message",
  "message_read",
  "read",
  "recovery",
  "review",
  "search",
  "tool",
]);

export function projectRuntimeActivityPath(
  records: readonly TeamHubRuntimePresentationEventRecord[],
  replies: ReadonlyMap<string, string> = new Map(),
  lifecycle: RuntimeActivityLifecycle = "active",
): RuntimeActivityPathItem[] {
  const activities = indexActivities(records);
  const items: RuntimeActivityPathItem[] = [];

  const markThinkingInactive = () => {
    const previous = items.at(-1);
    if (previous?.kind !== "thinking" || !previous.active) return;
    items[items.length - 1] = { ...previous, active: false };
  };

  const upsertThinking = (eventOrdinal: string, title: string) => {
    const previous = items.at(-1);
    if (previous?.kind === "thinking" && previous.title === title) {
      items[items.length - 1] = { ...previous, active: true };
      return;
    }
    if (previous?.kind === "thinking") {
      items[items.length - 1] = { ...previous, active: false };
    }
    items.push({
      active: true,
      kind: "thinking",
      key: `thinking:${eventOrdinal}`,
      title,
    });
  };

  for (const record of records) {
    const event = record.event;
    if (event.type === "status.changed") {
      if (event.status === "thinking" || event.status === "queued") {
        const title = event.title?.trim();
        if (title) {
          upsertThinking(record.event_ordinal, title);
        } else if (event.status === "thinking") {
          const previous = items.at(-1);
          if (previous?.kind === "thinking") {
            items[items.length - 1] = { ...previous, active: true };
          }
        }
        continue;
      }
      markThinkingInactive();
      if (
        event.status === "stopped" &&
        (event.outcome === "failed" || event.outcome === "canceled")
      ) {
        items.push({
          kind: "outcome",
          key: `outcome:${record.segment_id}:${record.event_ordinal}`,
          text:
            event.outcome === "failed"
              ? runtimeFailureMessage(event.failure)
              : "Run canceled",
          tone: event.outcome,
        });
      }
      continue;
    }
    if (event.type === "plan.updated") {
      upsertPlan(items, event);
      continue;
    }
    if (
      event.type === "presentation.output_created" &&
      event.output_kind === "message"
    ) {
      const text = replies.get(record.message_id ?? event.output_id)?.trim();
      if (text) {
        items.push({
          key: `reply:${event.output_id}`,
          kind: "reply",
          text,
        });
      }
      continue;
    }
    if (event.type !== "activity.started") continue;
    const activity = activities.get(event.activity_id);
    if (!activity) continue;
    markThinkingInactive();
    pushActivity(items, activity);
  }
  const stopped = records.some(
    (record) =>
      record.event.type === "status.changed" &&
      record.event.status === "stopped",
  );
  if (lifecycle === "active" && !stopped) return items;
  return items.map((item) => {
    if (item.kind === "tool_calls")
      return {
        ...item,
        calls: item.calls.map((call) => ({
          ...call,
          active: false,
          unconfirmed: call.outcome === undefined,
        })),
      };
    if (item.kind === "command" || item.kind === "activity")
      return {
        ...item,
        active: false,
        unconfirmed: item.outcome === undefined,
      };
    if (item.kind === "thinking") return { ...item, active: false };
    if (item.kind === "plan")
      return {
        ...item,
        steps: item.steps.map((step) =>
          step.status === "in_progress"
            ? { ...step, status: "pending" as const }
            : step,
        ),
      };
    return item;
  });
}

function upsertPlan(
  items: RuntimeActivityPathItem[],
  event: Extract<
    TeamHubRuntimePresentationEventRecord["event"],
    { type: "plan.updated" }
  >,
) {
  const plan: RuntimeActivityPathItem = {
    ...(event.explanation === undefined
      ? {}
      : { explanation: event.explanation }),
    key: "plan",
    kind: "plan",
    steps: event.steps.map((step) => ({ ...step })),
  };
  const index = items.findIndex((item) => item.kind === "plan");
  if (index >= 0) {
    items[index] = plan;
    return;
  }
  items.push(plan);
}

function indexActivities(
  records: readonly TeamHubRuntimePresentationEventRecord[],
) {
  const activities = new Map<string, RuntimeActivityPresentation>();
  for (const item of projectRuntimeChatPresentation(records).items) {
    if (item.type !== "status") continue;
    for (const activity of item.activities ?? []) {
      activities.set(activity.activityId, activity);
    }
  }
  return activities;
}

function pushActivity(
  items: RuntimeActivityPathItem[],
  activity: RuntimeActivityPresentation,
) {
  const entries = activity.entries ?? [];
  const active = activity.outcome === undefined;
  if (activity.kind === "response") return;
  if (activity.kind === "command") {
    items.push({
      active,
      entries,
      key: activity.activityId,
      kind: "command",
      name: commandSummary(activity),
      ...(activity.outcome === undefined ? {} : { outcome: activity.outcome }),
    });
    return;
  }
  if (activity.kind === "interaction") {
    items.push({
      active,
      activityKind: activity.kind,
      entries,
      key: activity.activityId,
      kind: "activity",
      title: activity.title,
      ...(activity.outcome === undefined ? {} : { outcome: activity.outcome }),
    });
    return;
  }
  if (!TOOL_KINDS.has(activity.kind)) return;
  const call: RuntimeActivityPathToolCall = {
    active,
    entries,
    id: activity.activityId,
    kind: activity.kind,
    name: activity.title,
    ...(activity.outcome === undefined ? {} : { outcome: activity.outcome }),
  };
  const previous = items.at(-1);
  if (previous?.kind === "tool_calls") {
    items[items.length - 1] = {
      ...previous,
      calls: [...previous.calls, call],
    };
    return;
  }
  items.push({
    calls: [call],
    kind: "tool_calls",
    key: `tools:${activity.activityId}`,
  });
}

function commandSummary(activity: RuntimeActivityPresentation) {
  const codeBlock = activity.entries?.find(
    (entry) =>
      entry.type === "content" &&
      (entry.block.format === "code" || entry.block.format === "json"),
  );
  if (codeBlock?.type === "content") {
    const firstLine = codeBlock.block.content.split("\n", 1)[0]?.trim();
    if (firstLine) return truncateCommand(firstLine);
  }
  return activity.detail ?? activity.title;
}

function truncateCommand(value: string) {
  return value.length > 88 ? `${value.slice(0, 85).trimEnd()}...` : value;
}
