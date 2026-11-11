import { Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  formatMessageTime,
  isRoomNotice,
  messageStartsConversation,
  timeStartsConversation,
} from "./message-grouping";
import { Icon } from "@/components/ui/icon";
import { useRoomRenderTiming } from "../room-render-timing";
import {
  activityStatusLine,
  toolPresentation,
  toolInputFromEntries,
} from "../runtime-status/runtime-tool-presentation";
import {
  AgentAvatarStatusContext,
  type AgentAvatarStatus,
} from "../members/agent-avatar-status-context";
import { runtimeFailureMessage } from "../runtime-status/runtime-failure-message";
import type { RuntimeExecutionFailure } from "../runtime-status/runtime-presentation-events";
import { Fragment, type ReactNode, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  TeamHubDocumentPreviewTarget,
  TeamHubMessagePresentation,
} from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActorRef,
  TeamHubMessage,
  TeamHubMessageDocumentSegment,
  TeamHubRunStatus,
  TeamHubMessageFileSegment,
  TeamHubMessageReactionId,
  TeamHubRoomRunCancelResult,
  TeamHubRoomRunRedeliverResult,
  TeamHubRuntimePresentationEventRecord,
} from "@/features/teamhub/teamhub-types";
import {
  projectRuntimeChatPresentation,
  type RuntimeActivityPresentation,
  type RuntimeChatPresentation,
  type RuntimeOutputPresentation,
  type RuntimePlanPresentation,
  type RuntimeStatusMark,
} from "@/features/rooms/runtime-status/runtime-presentation-events";

import { AgentRunResendButton, AgentRunStopButton } from "./room-run-controls";
import {
  useAgentStatusLine,
  type AgentStatusLineContent,
  type AgentStatusLineItem,
  type AgentStatusLineShown,
} from "./agent-status-line";
import {
  VoiceLiveDraftRow,
  type VoiceLiveDraft,
} from "./voice-mode/voice-live-draft";
import type { RoomCardDecision } from "../cards/room-message-card-contract";
import type { DocumentCardMetadata } from "../files/document-card-metadata";
import { ActorAvatar } from "../members/actor-avatar";
import { isRunWorking } from "@/features/teamhub/run-status";
import {
  MessageRow,
  PendingMessageRow,
  type PendingRoomMessage,
} from "./message-row";
import {
  LoadingOlderMessages,
  MessageTimelineEmptyState,
} from "./message-timeline-placeholders";
import { useMessageFilePreview } from "./use-message-file-preview";
import { useTimelineMessageGroups } from "./use-timeline-message-groups";

const EMPTY_LABELS: Readonly<Record<string, string>> = {};
const EMPTY_ACTOR_KINDS: Readonly<Record<string, "human" | "agent">> = {};
const EMPTY_DOCUMENT_METADATA: Readonly<Record<string, DocumentCardMetadata>> =
  {};
const EMPTY_RUN_STATUSES: TeamHubRunStatus[] = [];
const EMPTY_RUNTIME_EVENTS: Readonly<
  Record<string, readonly TeamHubRuntimePresentationEventRecord[]>
> = {};

const EMPTY_STATIC_AGENT_ACTOR_IDS: ReadonlySet<string> = new Set();

type LinkedSourceMessage =
  | { kind: "error"; retry: () => void }
  | { kind: "loading" }
  | { kind: "ready"; message: TeamHubMessage };

interface MessageTimelineProps {
  actorDisplayNames?: Readonly<Record<string, string>>;
  canLoadOlder: boolean;
  currentActorId?: string;
  documentTitles?: Readonly<Record<string, string>>;
  documentMetadata?: Readonly<Record<string, DocumentCardMetadata>>;
  loadingOlder: boolean;
  linkedSource?: LinkedSourceMessage;
  messageFilePreview?: "enabled" | "disabled";
  messages: TeamHubMessage[];
  /** Messages are about to appear, so an empty Room is not a fresh start. */
  messagesArriving?: boolean;
  runStatuses?: readonly TeamHubRunStatus[];
  voiceLiveDraft?: VoiceLiveDraft;
  memberActorIds?: ReadonlySet<string>;
  mentionableActorIds?: ReadonlySet<string>;
  onCancel: (clientId: string) => Promise<void> | void;
  onCardDecision: (decision: RoomCardDecision) => Promise<void> | void;
  onCloseLinkedSource: () => void;
  onOpenMessageFile: (
    segment: TeamHubMessageFileSegment | TeamHubMessageDocumentSegment,
  ) => Promise<void>;
  onOpenArtifact: (document: TeamHubDocumentPreviewTarget) => void;
  onOpenThread?: (
    message: TeamHubMessage,
    options?: { focusComposer?: boolean },
  ) => void;
  onOpenProfile: (actorId: string) => void;
  onOpenAgentActivity?: (
    actorId: string,
    runStatusId?: string,
    runId?: string,
  ) => void;
  onOpenDirectChat?: (actorId: string) => void;
  onOpenUrl?: (url: string) => void;
  onMentionAuthor?: (actor: TeamHubActorRef) => void;
  onForwardMessage?: (message: TeamHubMessage) => void;
  onReply?: (message: TeamHubMessage) => void;
  onToggleReaction?: (
    message: TeamHubMessage,
    reactionId: TeamHubMessageReactionId,
  ) => Promise<void>;
  actorKinds?: Readonly<Record<string, "human" | "agent">>;
  onRetry: (clientId: string) => void;
  pendingMessages: PendingRoomMessage[];
  presentations: Record<string, TeamHubMessagePresentation>;
  runtimePresentationEventsByRunStatusId?: Readonly<
    Record<string, readonly TeamHubRuntimePresentationEventRecord[]>
  >;
  selectedContextMessageIds?: ReadonlySet<string>;
  tenantId: string;
  focusedMessageId?: string | null;
  focusedMessageHighlight?: string | null;
  workspaceAgentIds?: ReadonlySet<string>;
}

export function MessageTimeline({
  actorDisplayNames = EMPTY_LABELS,
  canLoadOlder,
  currentActorId,
  documentTitles = EMPTY_LABELS,
  documentMetadata = EMPTY_DOCUMENT_METADATA,
  loadingOlder,
  linkedSource,
  messageFilePreview = "enabled",
  messages,
  messagesArriving = false,
  runStatuses = EMPTY_RUN_STATUSES,
  voiceLiveDraft,
  memberActorIds = EMPTY_STATIC_AGENT_ACTOR_IDS,
  mentionableActorIds = EMPTY_STATIC_AGENT_ACTOR_IDS,
  onCancel,
  onCardDecision,
  onCloseLinkedSource,
  onOpenMessageFile,
  onOpenArtifact,
  onOpenThread,
  onOpenProfile,
  onOpenAgentActivity,
  onOpenDirectChat,
  onOpenUrl,
  onMentionAuthor,
  onForwardMessage,
  onReply,
  onToggleReaction,
  actorKinds = EMPTY_ACTOR_KINDS,
  onRetry,
  pendingMessages,
  presentations,
  runtimePresentationEventsByRunStatusId = EMPTY_RUNTIME_EVENTS,
  selectedContextMessageIds = EMPTY_STATIC_AGENT_ACTOR_IDS,
  tenantId,
  focusedMessageId,
  focusedMessageHighlight,
  workspaceAgentIds = EMPTY_STATIC_AGENT_ACTOR_IDS,
}: MessageTimelineProps) {
  const { filePreviewError, previewMessageFile } =
    useMessageFilePreview(onOpenMessageFile);
  const { candidateMessages, openedAtNewest, startsOwnGroup } =
    useTimelineMessageGroups(messages, currentActorId);
  const runtimeViewCache = useRef<RuntimeTimelineViewCache>(new Map());
  const runtimeStatusViews = useMemo(
    () =>
      buildRuntimeTimelineViews({
        cache: runtimeViewCache.current,
        runStatuses,
        runtimePresentationEventsByRunStatusId,
      }),
    [runStatuses, runtimePresentationEventsByRunStatusId],
  );
  const hasTimelineContent = Boolean(
    candidateMessages.length || pendingMessages.length || voiceLiveDraft,
  );
  const avatarContext = useMemo(
    () => ({
      statuses: new Map(
        runtimeStatusViews.flatMap((row) =>
          isLiveAgentRunStatus(row)
            ? [[row.runStatus.agent.id, avatarStatus(row)] as const]
            : [],
        ),
      ),
      onOpenProfile,
      onOpenActivityLog: (actorId: string) => {
        const active = runtimeStatusViews.find(
          (row) =>
            row.runStatus.agent.id === actorId && isLiveAgentRunStatus(row),
        );
        onOpenAgentActivity?.(
          actorId,
          active?.runStatus.id,
          active?.runStatus.run_id,
        );
      },
    }),
    [onOpenProfile, onOpenAgentActivity, runtimeStatusViews],
  );
  const renderMessage = (message: TeamHubMessage, index: number) => {
    const previous = candidateMessages[index - 1];
    const startsConversation = messageStartsConversation(message, previous);
    return (
      <Fragment key={message.id}>
        {startsConversation ? (
          <div className="room-conversation-time text-center text-xs text-app-subtle">
            <time dateTime={message.created_at}>
              {formatMessageTime(message.created_at)}
            </time>
          </div>
        ) : null}
        <MessageRow
          entering={message.created_at > openedAtNewest}
          showAuthor={
            startsConversation ||
            previous?.author.id !== message.author.id ||
            isRoomNotice(previous)
          }
          actorDisplayNames={actorDisplayNames}
          currentActorId={currentActorId}
          documentTitles={documentTitles}
          documentMetadata={documentMetadata}
          message={message}
          messageFilePreview={messageFilePreview}
          canMentionAuthor={mentionableActorIds.has(message.author.id)}
          isAuthorMember={memberActorIds.has(message.author.id)}
          onCardDecision={onCardDecision}
          onOpenArtifact={onOpenArtifact}
          onOpenMessageFile={previewMessageFile}
          presentation={presentations[message.id]}
          onOpenProfile={onOpenProfile}
          onOpenDirectChat={onOpenDirectChat}
          onOpenUrl={onOpenUrl}
          onOpenThread={onOpenThread}
          onMentionAuthor={onMentionAuthor}
          onForwardMessage={onForwardMessage}
          onReply={onReply}
          onToggleReaction={onToggleReaction}
          actorKinds={actorKinds}
          selectedAsContext={selectedContextMessageIds.has(message.id)}
          tenantId={tenantId}
          focused={message.id === focusedMessageId}
          focusHighlight={
            message.id === focusedMessageId
              ? focusedMessageHighlight
              : undefined
          }
          workspaceAgentIds={workspaceAgentIds}
        />
      </Fragment>
    );
  };

  return (
    <AgentAvatarStatusContext.Provider value={avatarContext}>
      {linkedSource ? (
        <LinkedSourceMessagePanel
          actorDisplayNames={actorDisplayNames}
          currentActorId={currentActorId}
          documentTitles={documentTitles}
          documentMetadata={documentMetadata}
          linkedSource={linkedSource}
          messageFilePreview={messageFilePreview}
          memberActorIds={memberActorIds}
          mentionableActorIds={mentionableActorIds}
          onClose={onCloseLinkedSource}
          onCardDecision={onCardDecision}
          onOpenArtifact={onOpenArtifact}
          onOpenMessageFile={previewMessageFile}
          onOpenProfile={onOpenProfile}
          onOpenUrl={onOpenUrl}
          onOpenThread={onOpenThread}
          onMentionAuthor={onMentionAuthor}
          onReply={onReply}
          presentations={presentations}
          selectedContextMessageIds={selectedContextMessageIds}
          tenantId={tenantId}
          workspaceAgentIds={workspaceAgentIds}
        />
      ) : null}
      <div
        className={`room-readable px-0 ${hasTimelineContent || canLoadOlder ? "pt-3 pb-8" : "my-auto py-5"}`}
      >
        {/* Earlier Messages load as the reader scrolls near the top. */}
        {loadingOlder ? <LoadingOlderMessages /> : null}

        {hasTimelineContent ? (
          <div className="room-message-list flex flex-col gap-1">
            {candidateMessages.map((message, index) =>
              renderMessage(message, index),
            )}
            {pendingMessages.map((message, index) => {
              // A sending Message shows the time line its committed row
              // will show, so the commit does not insert one above it.
              const startsConversation = timeStartsConversation(
                message.createdAt,
                index > 0
                  ? pendingMessages[index - 1]!.createdAt
                  : candidateMessages.at(-1)?.created_at,
              );
              return (
                <Fragment key={message.clientId}>
                  {startsConversation ? (
                    <div className="room-conversation-time text-center text-xs text-app-subtle">
                      <time
                        dateTime={new Date(message.createdAt).toISOString()}
                      >
                        {formatMessageTime(
                          new Date(message.createdAt).toISOString(),
                        )}
                      </time>
                    </div>
                  ) : null}
                  <PendingMessageRow
                    actorId={currentActorId}
                    actorName={actorDisplayNames[currentActorId ?? ""] ?? "You"}
                    startsGroup={
                      startsConversation || (index === 0 && startsOwnGroup)
                    }
                    message={message}
                    onCancel={onCancel}
                    onOpenProfile={onOpenProfile}
                    onRetry={onRetry}
                  />
                </Fragment>
              );
            })}
            {voiceLiveDraft ? (
              <VoiceLiveDraftRow
                draft={voiceLiveDraft}
                startsGroup={pendingMessages.length === 0 && startsOwnGroup}
              />
            ) : null}
          </div>
        ) : messagesArriving ? null : (
          <MessageTimelineEmptyState />
        )}
      </div>
      {filePreviewError ? (
        <p className="room-readable mb-2 text-xs text-app-danger" role="alert">
          {filePreviewError}
        </p>
      ) : null}
    </AgentAvatarStatusContext.Provider>
  );
}

/**
 * Each Run's last view, kept while the Run stays listed. A Run is projected
 * again only when its status or its event list is a new object, so one Run's
 * runtime event does not re-project every other Run.
 */
type RuntimeTimelineViewCache = Map<
  string,
  {
    records: readonly TeamHubRuntimePresentationEventRecord[] | undefined;
    runStatus: TeamHubRunStatus;
    view: AgentRunStatusView | undefined;
  }
>;

export function buildRuntimeTimelineViews({
  cache,
  runStatuses,
  runtimePresentationEventsByRunStatusId,
}: {
  /** Reused and pruned to the given Runs on every pass. */
  cache?: RuntimeTimelineViewCache;
  runStatuses: readonly TeamHubRunStatus[];
  runtimePresentationEventsByRunStatusId: Readonly<
    Record<string, readonly TeamHubRuntimePresentationEventRecord[]>
  >;
}) {
  const runtimeStatusViews: AgentRunStatusView[] = [];
  const listed = new Set<string>();
  for (const runStatus of runStatuses) {
    const records = runtimePresentationEventsByRunStatusId[runStatus.id];
    const cached = cache?.get(runStatus.id);
    const view =
      cached?.runStatus === runStatus && cached.records === records
        ? cached.view
        : runtimeTimelineView(runStatus, records);
    listed.add(runStatus.id);
    cache?.set(runStatus.id, { records, runStatus, view });
    if (view) runtimeStatusViews.push(view);
  }
  for (const runStatusId of cache?.keys() ?? []) {
    if (!listed.has(runStatusId)) cache?.delete(runStatusId);
  }
  return runtimeStatusViews;
}

function runtimeTimelineView(
  runStatus: TeamHubRunStatus,
  records: readonly TeamHubRuntimePresentationEventRecord[] | undefined,
) {
  const presentation = records
    ? projectRuntimeChatPresentation(records)
    : undefined;
  const history = resolveAgentRunStatusHistory({ runStatus, presentation });
  if (history.length === 0) return undefined;
  return createAgentRunStatusView(runStatus, history, history.at(-1)!.key);
}

function TypingDots({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`town-dots shrink-0 ${className}`}>
      <span />
      <span />
      <span />
    </span>
  );
}

type AgentRuntimeState =
  | "Canceled"
  | "Completed"
  | "Failed"
  | "Needs attention"
  | "Recovering"
  | "Responding"
  | "Stopped"
  | "Thinking"
  | "Waiting for your input"
  | "Working";

interface AgentRuntimeStatusSegment {
  activities: readonly RuntimeActivityPresentation[];
  key: string;
  /** What the Dock's status line shows for this Agent. */
  line: AgentStatusLineContent;
  /** The entries of the line's current group, ending with `line`. */
  lineQueue?: readonly AgentStatusLineItem[];
  outputs: readonly RuntimeOutputPresentation[];
  plan?: RuntimePlanPresentation;
  state: AgentRuntimeState;
  summary: string;
  /** The Run ended with follow-ups whose delivery is unconfirmed. */
  unconfirmedFollowUps?: true;
}

type AgentRunStatusView = AgentRuntimeStatusSegment & {
  runStatus: TeamHubRunStatus;
  highlightedSegmentKey: string;
  history: readonly AgentRuntimeStatusSegment[];
};

function isLiveAgentRunStatus(runtimeStatus: AgentRunStatusView) {
  return (
    isRunWorking(runtimeStatus.runStatus) &&
    runtimeStatus.state !== "Canceled" &&
    runtimeStatus.state !== "Completed" &&
    runtimeStatus.state !== "Failed" &&
    runtimeStatus.state !== "Stopped" &&
    runtimeStatus.state !== "Needs attention"
  );
}

function resolveAgentRunStatusHistory({
  runStatus,
  presentation,
}: {
  runStatus: Pick<TeamHubRunStatus, "status">;
  presentation?: RuntimeChatPresentation;
}): readonly AgentRuntimeStatusSegment[] {
  if (presentation) {
    const history = presentation.items
      .filter((item) => item.type === "status")
      .map((item, index) =>
        resolveAgentRuntimeStatusSegment({
          activities: item.activities,
          first: index === 0,
          key: item.key,
          marks: item.marks,
          outputs: item.outputs,
          plan: item.plan,
          status: item.status,
          terminalOutcome: item.terminalOutcome,
          failure: item.failure,
          title: item.title,
          unconfirmedInputIds: item.unconfirmedInputIds,
        }),
      );
    if (history.length > 0) return history;
    if (!presentation.currentStatus) {
      return runStatus.status === "active"
        ? [fallbackAgentRuntimeStatusSegment()]
        : runStatus.status === "aborted"
          ? [stoppedAgentRuntimeStatusSegment()]
          : [];
    }
    return [
      resolveAgentRuntimeStatusSegment({
        first: true,
        key: "snapshot",
        status: presentation.currentStatus,
        title: presentation.currentTitle,
      }),
    ];
  }

  return runStatus.status === "active"
    ? [fallbackAgentRuntimeStatusSegment()]
    : runStatus.status === "aborted"
      ? [stoppedAgentRuntimeStatusSegment()]
      : [];
}

function fallbackAgentRuntimeStatusSegment(): AgentRuntimeStatusSegment {
  return resolveAgentRuntimeStatusSegment({
    first: true,
    key: "snapshot",
    status: "working",
  });
}

// An aborted Run status covers both failed and canceled Runs; until its
// presentation events arrive, the outcome and its cause are not known.
function stoppedAgentRuntimeStatusSegment(): AgentRuntimeStatusSegment {
  return {
    activities: [],
    key: "stopped",
    line: { tone: "warn", text: "Run stopped" },
    outputs: [],
    state: "Stopped",
    summary: "Run stopped",
  };
}

function resolveAgentRuntimeStatusSegment({
  activities = [],
  first = false,
  key,
  marks = [],
  outputs = [],
  plan,
  status,
  terminalOutcome,
  title,
  unconfirmedInputIds,
  failure,
}: {
  activities?: readonly RuntimeActivityPresentation[];
  /** The Run's first Segment, before which the Agent has done nothing. */
  first?: boolean;
  key: string;
  /** Thinking and Activity starts in order, for the Dock's status line. */
  marks?: readonly RuntimeStatusMark[];
  outputs?: readonly RuntimeOutputPresentation[];
  plan?: RuntimePlanPresentation;
  status: "queued" | "working" | "thinking";
  terminalOutcome?: "canceled" | "completed" | "failed";
  failure?: RuntimeExecutionFailure;
  /** The thinking summary while the status is thinking. */
  title?: string;
  unconfirmedInputIds?: readonly string[];
}): AgentRuntimeStatusSegment {
  const activeActivities = activities
    .filter((activity) => activity.outcome === undefined)
    .reverse();
  // Replayed native activities may arrive after the recovery activity. They do
  // not establish that the cloud has caught up with the Computer yet.
  const activeActivity =
    activeActivities.find((activity) => activity.kind === "recovery") ??
    activeActivities[0];
  const terminalSummary =
    terminalOutcome === "completed"
      ? "Run completed"
      : terminalOutcome === "canceled"
        ? "Run canceled"
        : terminalOutcome === "failed"
          ? runtimeFailureMessage(failure)
          : undefined;
  const unconfirmed = Boolean(terminalOutcome && unconfirmedInputIds?.length);
  const summary =
    (unconfirmed
      ? `${terminalOutcome === "failed" ? `${terminalSummary}. ` : ""}Follow-up delivery unconfirmed. Resend it if the Agent did not answer.`
      : undefined) ??
    terminalSummary ??
    (activeActivity?.kind === "interaction"
      ? "Waiting for your input"
      : undefined) ??
    (activeActivity ? activitySummary(activeActivity) : undefined) ??
    (status === "queued"
      ? "Thinking"
      : status === "thinking"
        ? "Planning the next step"
        : "Working on your request");
  const state =
    unconfirmed && terminalOutcome !== "failed"
      ? "Needs attention"
      : terminalOutcome === "completed"
        ? "Completed"
        : terminalOutcome === "canceled"
          ? "Canceled"
          : terminalOutcome === "failed"
            ? "Failed"
            : activeActivity?.kind === "recovery"
              ? "Recovering"
              : activeActivity?.kind === "interaction"
                ? "Waiting for your input"
                : status === "thinking"
                  ? "Thinking"
                  : activeActivity?.kind === "response"
                    ? "Responding"
                    : "Working";
  // Like grok-bot's, the status line names what the Agent did last and plays
  // the entries of its current group in order (see statusLineQueue). Dots
  // wait for the Agent's first Activity or thinking, and Working follows a
  // message once it has gone out (an output closes its Segment).
  const queue = statusLineQueue(marks, activities);
  const lineRunning = activities
    .filter(
      (activity) =>
        activity.outcome === undefined && activity.kind !== "message",
    )
    .reverse();
  // Recovery and waiting for input name the Agent's state, not a step.
  const stateActivity =
    lineRunning.find((activity) => activity.kind === "recovery") ??
    lineRunning.find((activity) => activity.kind === "interaction");
  const line: AgentStatusLineContent =
    state === "Failed"
      ? {
          tone: "danger",
          text:
            terminalSummary === "Run failed"
              ? terminalSummary
              : `Run failed: ${terminalSummary}`,
        }
      : state === "Needs attention"
        ? { tone: "warn", text: "Follow-up delivery unconfirmed" }
        : stateActivity
          ? {
              tone: "live",
              text: activityStatusLine(stateActivity.kind).steps[0]!,
              runningActivityId: stateActivity.activityId,
            }
          : status === "queued"
            ? { tone: "wait" }
            : outputs.length > 0 && lineRunning.length === 0
              ? { tone: "live", text: "Working" }
              : queue.length > 0
                ? queue.at(-1)!.content
                : status === "thinking"
                  ? { tone: "live", text: title?.trim() || "Thinking" }
                  : first && activities.length === 0
                    ? { tone: "wait" }
                    : { tone: "live", text: "Working" };
  const lineQueue =
    queue.length > 0 && line === queue.at(-1)!.content ? queue : undefined;
  return {
    activities,
    key,
    line,
    ...(lineQueue ? { lineQueue } : {}),
    outputs,
    plan,
    state,
    summary,
    ...(unconfirmed ? { unconfirmedFollowUps: true as const } : {}),
  };
}

/**
 * The status line's entries since the latest group began. Thinking, with its
 * title, and a Runtime's own description of an Activity start a group; the
 * steps of each Activity follow. A command the Computer could not name adds
 * nothing, so the line keeps its last text, and a message is left out: it
 * is in the Room when its Activity arrives.
 */
function statusLineQueue(
  marks: readonly RuntimeStatusMark[],
  activities: readonly RuntimeActivityPresentation[],
): AgentStatusLineItem[] {
  const byId = new Map(
    activities.map((activity) => [activity.activityId, activity]),
  );
  let items: { key: string; text: string; runningActivityId?: string }[] = [];
  for (const mark of marks) {
    if (mark.type === "thinking") {
      items = [{ key: mark.key, text: mark.title?.trim() || "Thinking" }];
      continue;
    }
    const activity = byId.get(mark.activityId);
    if (
      !activity ||
      activity.kind === "message" ||
      activity.kind === "recovery" ||
      activity.kind === "interaction"
    )
      continue;
    const running =
      activity.outcome === undefined
        ? { runningActivityId: activity.activityId }
        : {};
    const named = activityStatusLine(
      activity.kind,
      toolInputFromEntries(activity.entries),
    );
    if (named.title) {
      items = [
        { key: `${activity.activityId}:title`, text: named.title, ...running },
      ];
      continue;
    }
    named.steps.forEach((text, index) => {
      const last = index === named.steps.length - 1;
      const item = {
        key: `${activity.activityId}:${index}`,
        text,
        ...(last ? running : {}),
      };
      // The same words twice in a row stay one entry, keeping its key so the
      // line does not replay them.
      const previous = items.at(-1);
      if (previous?.text === text)
        items[items.length - 1] = { ...item, key: previous.key };
      else items.push(item);
    });
  }
  return items.map(({ key, text, runningActivityId }) => ({
    key,
    content: {
      tone: "live",
      text,
      ...(runningActivityId === undefined ? {} : { runningActivityId }),
    },
  }));
}

function activitySummary(activity: RuntimeActivityPresentation) {
  if (activity.kind === "interaction") return "Waiting for your input";
  if (activity.kind === "response") return "Preparing a reply";
  return toolPresentation(activity.kind).summary;
}

function createAgentRunStatusView(
  runStatus: TeamHubRunStatus,
  history: readonly AgentRuntimeStatusSegment[],
  highlightedSegmentKey: string,
): AgentRunStatusView {
  const highlighted =
    history.find((segment) => segment.key === highlightedSegmentKey) ??
    history[history.length - 1]!;
  return {
    ...highlighted,
    runStatus,
    highlightedSegmentKey: highlighted.key,
    history,
  };
}

function avatarStatus(row: AgentRunStatusView): AgentAvatarStatus {
  return {
    status: runtimeStatusDisplayState(row.state),
    activities: row.activities.flatMap((activity) =>
      activity.outcome
        ? []
        : [{ id: activity.activityId, label: activitySummary(activity) }],
    ),
  };
}

interface AgentStreamingDockEntry {
  agent: {
    display_name: string;
    id: string;
    kind: "agent";
  };
  key: string;
  /** The Run the entry shows; a local typing entry has none. */
  runId?: string;
  runtimeStatus?: AgentRunStatusView;
}

/** An Agent the Dock shows as starting without a Run, such as paced setup. */
export interface AgentStreamingTypingAgent {
  display_name: string;
  id: string;
}

const EMPTY_SCOPE_KEY: readonly string[] = [];

export function AgentStreamingStatusDock({
  cancelRoomRun,
  redeliverRoomRun,
  runStatuses = EMPTY_RUN_STATUSES,
  onViewActivity,
  runtimePresentationEventsByRunStatusId = EMPTY_RUNTIME_EVENTS,
  scopeKey = EMPTY_SCOPE_KEY,
  typingAgent,
}: {
  cancelRoomRun?: (
    runId: string,
    requestId: string,
  ) => Promise<TeamHubRoomRunCancelResult>;
  /** Resends a finished Run's unconfirmed follow-ups to its Agent. */
  redeliverRoomRun?: (runId: string) => Promise<TeamHubRoomRunRedeliverResult>;
  runStatuses?: readonly TeamHubRunStatus[];
  onViewActivity?: (
    runStatusId: string,
    agent: {
      display_name: string;
      id: string;
      kind: "agent";
    },
    runId?: string,
  ) => void;
  runtimePresentationEventsByRunStatusId?: Readonly<
    Record<string, readonly TeamHubRuntimePresentationEventRecord[]>
  >;
  /** Scopes the Stop state to the Room or Thread that shows the Dock. */
  scopeKey?: readonly string[];
  /** Shown only while that Agent has no Run status; it offers no Stop. */
  typingAgent?: AgentStreamingTypingAgent;
}) {
  const runtimeViewCache = useRef<RuntimeTimelineViewCache>(new Map());
  const runtimeStatuses = useMemo(
    () =>
      dockRuntimeStatuses(
        runStatuses,
        runtimePresentationEventsByRunStatusId,
        runtimeViewCache.current,
      ),
    [runStatuses, runtimePresentationEventsByRunStatusId],
  );
  const entries = useMemo<AgentStreamingDockEntry[]>(() => {
    const next: AgentStreamingDockEntry[] = runtimeStatuses.map(
      (runtimeStatus) => ({
        agent: runtimeStatus.runStatus.agent,
        key: runtimeStatus.runStatus.agent.id,
        runId: runtimeStatus.runStatus.run_id,
        runtimeStatus,
      }),
    );
    if (!typingAgent) return next;
    // A new request replaces the Agent's old failure, but never a live Run.
    const existing = next.findIndex((entry) => entry.key === typingAgent.id);
    const typing = {
      agent: { ...typingAgent, kind: "agent" as const },
      key: typingAgent.id,
    };
    if (existing < 0) next.push(typing);
    else if (!isLiveAgentRunStatus(next[existing]!.runtimeStatus!))
      next[existing] = typing;
    return next;
  }, [runtimeStatuses, typingAgent]);
  const [hovered, setHovered] = useState(false);
  const lineTargets = useMemo(
    () =>
      entries.map((entry) => ({
        id: entry.key,
        content: dockEntryLine(entry),
        ...(entry.runtimeStatus?.lineQueue
          ? { queue: entry.runtimeStatus.lineQueue }
          : {}),
      })),
    [entries],
  );
  const line = useAgentStatusLine(lineTargets, hovered);
  const workingEntries = entries.filter(
    (entry) =>
      entry.runtimeStatus?.state !== "Failed" &&
      entry.runtimeStatus?.state !== "Stopped" &&
      entry.runtimeStatus?.state !== "Needs attention",
  );
  useRoomRenderTiming("dock", {
    result: workingEntries.length ? "working" : "stopped",
    runStatusIds: workingEntries.flatMap((entry) =>
      entry.runtimeStatus ? [entry.runtimeStatus.runStatus.id] : [],
    ),
    runIds: workingEntries.flatMap((entry) =>
      entry.runId ? [entry.runId] : [],
    ),
  });

  if (entries.length === 0) return null;

  const failedCount = entries.filter(
    (entry) =>
      entry.runtimeStatus?.state === "Failed" ||
      entry.runtimeStatus?.state === "Stopped",
  ).length;
  const attentionCount = entries.filter(
    (entry) => entry.runtimeStatus?.state === "Needs attention",
  ).length;
  const statusLabel =
    failedCount || attentionCount ? "Agent status" : "Agents working";
  const shownEntry = entries.find((entry) => entry.key === line.current?.id);
  const shownActivity = shownEntry?.runtimeStatus
    ? {
        runStatusId: shownEntry.runtimeStatus.runStatus.id,
        runId: shownEntry.runtimeStatus.runStatus.run_id,
      }
    : undefined;

  return (
    // The status floats over the timeline's bottom padding instead of taking
    // layout height, so its arrival never pushes the last Message up.
    <div className="relative h-0">
      <div
        className="room-readable absolute inset-x-0 bottom-1 bg-app-surface"
        data-testid="agent-streaming-status-dock"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setHovered(false);
        }}
        onFocus={() => setHovered(true)}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <div className="flex min-h-7 max-w-full items-center gap-1">
          <button
            aria-label={`Open ${statusLabel} activity`}
            className="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left text-xs text-app-muted transition-colors hover:bg-app-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-app-focus disabled:hover:bg-transparent"
            disabled={!shownActivity}
            onClick={() => {
              // The status line opens the shown Agent's Activity panel.
              if (!shownActivity || !shownEntry) return;
              if (shownActivity.runId)
                onViewActivity?.(
                  shownActivity.runStatusId,
                  shownEntry.agent,
                  shownActivity.runId,
                );
              else
                onViewActivity?.(shownActivity.runStatusId, shownEntry.agent);
            }}
            title={
              shownEntry && line.current
                ? `${shownEntry.agent.display_name}: ${statusLineText(line.current.content)}`
                : undefined
            }
            type="button"
          >
            <StatusLineRoll
              className="size-5 shrink-0"
              current={line.current}
              previous={line.previous}
              itemKey={(shown) => shown.id}
              render={(shown) => {
                const entry = entries.find((item) => item.key === shown.id);
                return (
                  <ActorAvatar
                    actorId={shown.id}
                    kind="agent"
                    name={entry?.agent.display_name ?? ""}
                    size="xxs"
                  />
                );
              }}
            />
            <StatusLineRoll
              className="h-4 min-w-0 flex-1"
              current={line.current}
              previous={line.previous}
              itemKey={(shown) => `${shown.id}:${shown.key}`}
              render={(shown) => (
                <StatusLineText
                  content={shown.content}
                  minutes={shown.minutes}
                />
              )}
            />
          </button>
          {shownEntry ? (
            <>
              <DockEntryStop
                cancelRoomRun={cancelRoomRun}
                entry={shownEntry}
                scopeKey={scopeKey}
              />
              <DockEntryResend
                entry={shownEntry}
                redeliverRoomRun={redeliverRoomRun}
                scopeKey={scopeKey}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DockEntryStop({
  cancelRoomRun,
  entry,
  scopeKey,
}: {
  cancelRoomRun?: (
    runId: string,
    requestId: string,
  ) => Promise<TeamHubRoomRunCancelResult>;
  entry: AgentStreamingDockEntry;
  scopeKey: readonly string[];
}) {
  const { runId, runtimeStatus } = entry;
  if (
    !runId ||
    !cancelRoomRun ||
    !runtimeStatus ||
    !isLiveAgentRunStatus(runtimeStatus)
  )
    return null;
  // The status line keeps Stop mounted, so a new Run gets a new button and
  // request ID; a stop in flight is still found through its Run.
  return (
    <AgentRunStopButton
      cancel={(requestId) => cancelRoomRun(runId, requestId)}
      controlKey={entry.agent.id}
      key={runId}
      runId={runId}
      name={entry.agent.display_name}
      scopeKey={scopeKey}
    />
  );
}

function DockEntryResend({
  entry,
  redeliverRoomRun,
  scopeKey,
}: {
  entry: AgentStreamingDockEntry;
  redeliverRoomRun?: (runId: string) => Promise<TeamHubRoomRunRedeliverResult>;
  scopeKey: readonly string[];
}) {
  const { runId, runtimeStatus } = entry;
  if (!runId || !redeliverRoomRun || !runtimeStatus?.unconfirmedFollowUps)
    return null;
  return (
    <AgentRunResendButton
      controlKey={entry.agent.id}
      key={runId}
      name={entry.agent.display_name}
      redeliver={() => redeliverRoomRun(runId)}
      runId={runId}
      scopeKey={scopeKey}
    />
  );
}

function dockRuntimeStatuses(
  runStatuses: readonly TeamHubRunStatus[],
  runtimePresentationEventsByRunStatusId: Readonly<
    Record<string, readonly TeamHubRuntimePresentationEventRecord[]>
  >,
  cache: RuntimeTimelineViewCache,
) {
  const latestByAgent = new Map<string, TeamHubRunStatus>();
  for (const runStatus of runStatuses) {
    const current = latestByAgent.get(runStatus.agent.id);
    // A working Run wins over ended ones so its Stop stays reachable; among
    // equals, Run order follows creation, not a delayed update to an older
    // failure.
    const working = isRunWorking(runStatus);
    if (
      !current ||
      (working && !isRunWorking(current)) ||
      (working === isRunWorking(current) &&
        (current.created_at < runStatus.created_at ||
          (current.created_at === runStatus.created_at &&
            current.id < runStatus.id)))
    ) {
      latestByAgent.set(runStatus.agent.id, runStatus);
    }
  }
  // Select before projection: a completed Run may have no displayable history.
  return buildRuntimeTimelineViews({
    cache,
    runStatuses: [...latestByAgent.values()],
    runtimePresentationEventsByRunStatusId,
  }).filter(
    (row) =>
      isLiveAgentRunStatus(row) ||
      row.state === "Failed" ||
      row.state === "Stopped" ||
      row.state === "Needs attention",
  );
}

function dockEntryLine(entry: AgentStreamingDockEntry): AgentStatusLineContent {
  if (entry.runtimeStatus) return entry.runtimeStatus.line;
  return { tone: "wait" };
}

function statusLineText(content: AgentStatusLineContent) {
  return content.tone === "wait" ? "Starting" : content.text;
}

/** The line's text; a long-running Activity's minutes follow it directly. */
function StatusLineText({
  content,
  minutes,
}: {
  content: AgentStatusLineContent;
  minutes?: number;
}) {
  if (content.tone === "wait")
    return <TypingDots className="text-app-subtle" />;
  const text = (
    <span
      className={cn(
        "block min-w-0 truncate leading-4",
        content.tone === "live" && "town-status-shimmer",
        content.tone === "muted" && "text-app-subtle",
        content.tone === "danger" && "text-app-danger",
        content.tone === "warn" && "text-app-warning",
      )}
    >
      {content.text}
    </span>
  );
  if (!minutes) return text;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {text}
      <span className="shrink-0 leading-4 text-app-subtle tabular-nums">
        · {minutes}m
      </span>
    </span>
  );
}

/** Rolls a new item up from below while the previous one leaves the top. */
function StatusLineRoll({
  className,
  current,
  itemKey,
  previous,
  render,
}: {
  className: string;
  current?: AgentStatusLineShown;
  itemKey: (shown: AgentStatusLineShown) => string;
  previous?: AgentStatusLineShown;
  render: (shown: AgentStatusLineShown) => ReactNode;
}) {
  const currentKey = current ? itemKey(current) : undefined;
  return (
    <span className={cn("grid grid-cols-1 overflow-hidden", className)}>
      {previous && itemKey(previous) !== currentKey ? (
        <span
          aria-hidden="true"
          className="town-status-roll-out col-start-1 row-start-1 flex min-w-0 items-center"
          key={`out:${itemKey(previous)}`}
        >
          {render(previous)}
        </span>
      ) : null}
      {current ? (
        <span
          className="town-status-roll-in col-start-1 row-start-1 flex min-w-0 items-center"
          key={`in:${currentKey}`}
        >
          {render(current)}
        </span>
      ) : null}
    </span>
  );
}

function runtimeStatusDisplayState(state: AgentRuntimeState) {
  return state === "Responding" ? "Typing" : state;
}

function LinkedSourceMessagePanel({
  actorDisplayNames,
  currentActorId,
  documentTitles,
  documentMetadata,
  linkedSource,
  messageFilePreview,
  memberActorIds,
  mentionableActorIds,
  onClose,
  onCardDecision,
  onOpenArtifact,
  onOpenMessageFile,
  onOpenProfile,
  onOpenUrl,
  onOpenThread,
  onMentionAuthor,
  onReply,
  presentations,
  selectedContextMessageIds,
  tenantId,
  workspaceAgentIds,
}: {
  actorDisplayNames: Readonly<Record<string, string>>;
  currentActorId?: string;
  documentTitles: Readonly<Record<string, string>>;
  documentMetadata: Readonly<Record<string, DocumentCardMetadata>>;
  linkedSource: LinkedSourceMessage;
  messageFilePreview: "enabled" | "disabled";
  memberActorIds: ReadonlySet<string>;
  mentionableActorIds: ReadonlySet<string>;
  onClose: () => void;
  onCardDecision: (decision: RoomCardDecision) => Promise<void> | void;
  onOpenArtifact: (document: TeamHubDocumentPreviewTarget) => void;
  onOpenMessageFile: (
    segment: TeamHubMessageFileSegment | TeamHubMessageDocumentSegment,
  ) => void;
  onOpenProfile: (actorId: string) => void;
  onOpenUrl?: (url: string) => void;
  onOpenThread?: (
    message: TeamHubMessage,
    options?: { focusComposer?: boolean },
  ) => void;
  onMentionAuthor?: (actor: TeamHubActorRef) => void;
  onForwardMessage?: (message: TeamHubMessage) => void;
  onReply?: (message: TeamHubMessage) => void;
  presentations: Record<string, TeamHubMessagePresentation>;
  selectedContextMessageIds: ReadonlySet<string>;
  tenantId: string;
  workspaceAgentIds: ReadonlySet<string>;
}) {
  return (
    <section
      aria-label="Linked source Message"
      className="border-b border-app-border bg-app-surface-soft"
    >
      <div className="room-readable px-4 py-3 md:px-0">
        <div className="mb-2 flex min-h-8 items-center justify-between gap-3">
          <p className="text-xs font-semibold text-app-muted">
            Linked source Message
          </p>
          <Button
            aria-label="Close linked source Message"
            onClick={onClose}
            size="compactIcon"
            title="Close linked source Message"
            tone="ghost"
          >
            <Icon icon={Cancel01Icon} size={14} />
          </Button>
        </div>
        {linkedSource.kind === "loading" ? (
          <div className="flex gap-2.5 py-3" role="status">
            <span className="sr-only">Loading source Message…</span>
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex items-center gap-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-2 w-10" />
              </div>
              <Skeleton className="mt-2.5 h-3 w-4/5" />
              <Skeleton className="mt-1.5 h-3 w-2/5" />
            </div>
          </div>
        ) : linkedSource.kind === "error" ? (
          <div
            className="flex min-h-12 items-center justify-between gap-3"
            role="alert"
          >
            <p className="text-sm text-app-muted">
              Source Message is unavailable.
            </p>
            <Button onClick={linkedSource.retry} size="compact">
              Retry
            </Button>
          </div>
        ) : (
          <MessageRow
            actorDisplayNames={actorDisplayNames}
            currentActorId={currentActorId}
            documentTitles={documentTitles}
            documentMetadata={documentMetadata}
            messageFilePreview={messageFilePreview}
            message={linkedSource.message}
            onOpenUrl={onOpenUrl}
            canMentionAuthor={mentionableActorIds.has(
              linkedSource.message.author.id,
            )}
            isAuthorMember={memberActorIds.has(linkedSource.message.author.id)}
            onCardDecision={onCardDecision}
            onOpenArtifact={onOpenArtifact}
            onOpenMessageFile={onOpenMessageFile}
            onOpenProfile={onOpenProfile}
            onOpenThread={onOpenThread}
            onMentionAuthor={onMentionAuthor}
            onReply={onReply}
            presentation={presentations[linkedSource.message.id]}
            selectedAsContext={selectedContextMessageIds.has(
              linkedSource.message.id,
            )}
            tenantId={tenantId}
            workspaceAgentIds={workspaceAgentIds}
          />
        )}
      </div>
    </section>
  );
}
