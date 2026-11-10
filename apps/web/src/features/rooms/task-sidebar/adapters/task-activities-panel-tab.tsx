import { dateTimeFormat } from "@/lib/date-format";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Activity01Icon,
  ArrowRight01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubMessage,
  TeamHubRunStatus,
  TeamHubTaskExecution,
} from "@/features/teamhub/teamhub-types";
import {
  isTaskActivityNotFound,
  taskExecutionStopped,
  useTaskActivities,
} from "@/features/work-items/use-task-activities";
import { roomMessagesInfiniteQueryOptions } from "../../room-queries";
import { ActorAvatar } from "../../members/actor-avatar";
import { MessageMarkdown } from "../../chat/message-markdown";
import { RuntimeActivityPath } from "../../runtime-status/runtime-activity-path-view";
import { useTaskActivityEvents } from "../../runtime-status/use-task-activity-events";
import { RunningDots } from "../running-dots";
import { PanelLoading } from "../panel-loading";

const stageLabels: Record<TeamHubTaskExecution["status"], string> = {
  running: "Running",
  waiting_for_approval: "Waiting for approval",
  idle: "Idle",
  failed: "Failed",
  canceled: "Stopped",
};
const tabs = ["Activity", "Details"] as const;

export function TaskActivitiesPanelTab({
  hidden,
  taskId,
  tenantId,
}: {
  hidden: boolean;
  taskId: string;
  tenantId: string;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number]>("Activity");
  const data = useTaskActivities({ tenantId, taskId, enabled: !hidden });
  const { client } = useTeamHubRuntime();
  const messages = useInfiniteQuery({
    ...roomMessagesInfiniteQueryOptions(client, tenantId, data.roomId ?? ""),
    enabled: !hidden && Boolean(data.roomId),
    refetchInterval:
      !hidden && data.roomId && !taskExecutionStopped(data.execution.data)
        ? 2_000
        : false,
  });
  const publicMessages =
    messages.data?.pages.flatMap((page) => page.items) ?? [];
  const execution = data.execution.data;
  const item = data.item.data;
  const stopped = taskExecutionStopped(execution);
  const status = execution
    ? stageLabels[execution.status]
    : (item?.state.replaceAll("_", " ") ?? "");
  const refresh = () => {
    void data.item.refetch();
    void data.execution.refetch();
    void data.activities.refetch();
    if (data.roomId) void messages.refetch();
  };
  return (
    <section
      className={hidden ? "hidden" : "flex h-full min-h-0 flex-col bg-card"}
      hidden={hidden || undefined}
      inert={hidden || undefined}
      data-testid="task-activities-panel"
      aria-label="Task activities"
    >
      <header className="shrink-0 border-b border-app-border px-4 pb-3 pt-4">
        <div className="flex items-center gap-2 text-xs text-app-muted">
          <Icon icon={Activity01Icon} size={14} />
          <span>Task {item ? `#${item.number}` : ""}</span>
          <button
            type="button"
            aria-label="Refresh task"
            onClick={refresh}
            className="ml-auto rounded-lg p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Icon icon={RefreshIcon} size={14} />
          </button>
        </div>
        <h2 className="mt-2 break-words text-sm font-semibold text-app-ink">
          {item?.title ?? "Task activity"}
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-muted px-2 py-0.5 capitalize text-muted-foreground">
            {status}
          </span>
          {execution?.current_attempt ? (
            <span className="text-app-muted">
              Attempt {execution.current_attempt.attempt_number}
            </span>
          ) : null}
        </div>
        {execution ? (
          <p className="mt-2 text-2xs text-app-muted">
            Updated {formatTime(execution.execution_updated_at)}
          </p>
        ) : null}
      </header>
      <nav
        aria-label="Task sections"
        className="flex shrink-0 gap-1 border-b border-border px-3 py-2"
      >
        {tabs.map((value) => (
          <button
            type="button"
            aria-current={tab === value ? "page" : undefined}
            key={value}
            onClick={() => setTab(value)}
            className={`rounded-full px-3 py-1 text-sm font-medium transition-colors duration-150 ${tab === value ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
          >
            {value}
          </button>
        ))}
      </nav>
      <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto">
        {data.item.error ? (
          <State>Task could not be loaded.</State>
        ) : data.item.isPending ? (
          <State busy>Loading task…</State>
        ) : (
          <>
            {data.execution.error ? (
              <State>Execution status could not be loaded.</State>
            ) : null}
            {tab === "Activity" ? (
              <>
                {data.activities.error ? (
                  <State>
                    {isTaskActivityNotFound(data.activities.error)
                      ? "You do not have access to this task’s work room activity."
                      : "Activity could not be loaded. Try refreshing."}
                  </State>
                ) : data.activities.isPending ? (
                  <State busy>Loading activity…</State>
                ) : (
                  <>
                    {data.roomId && !data.connected ? (
                      <State>Reconnecting to live activity…</State>
                    ) : null}
                    {!data.runStatuses.length ? (
                      <State>
                        No published activity yet. Earlier runs may not have an
                        activity history.
                      </State>
                    ) : null}
                    {data.roomId
                      ? data.runStatuses.map((runStatus) => (
                          <TaskActivityGroup
                            key={runStatus.id}
                            runStatus={runStatus}
                            tenantId={tenantId}
                            roomId={data.roomId!}
                            visible={!hidden}
                            stopped={stopped}
                            paused={
                              execution?.status === "waiting_for_approval"
                            }
                            messages={publicMessages}
                          />
                        ))
                      : null}
                    {data.activities.hasNextPage ? (
                      <div className="px-4 py-3">
                        <Button
                          size="compact"
                          tone="ghost"
                          disabled={data.activities.isFetchingNextPage}
                          onClick={() => void data.activities.fetchNextPage()}
                        >
                          Load earlier activity
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
                {data.roomId ? (
                  <div className="border-t border-app-border px-4 py-4">
                    <h3 className="mb-3 text-xs font-medium text-app-body">
                      Task messages
                    </h3>
                    {messages.error ? (
                      <p className="text-xs text-app-muted">
                        Messages could not be loaded.
                      </p>
                    ) : !publicMessages.length ? (
                      <p className="text-xs text-app-muted">
                        No task messages yet.
                      </p>
                    ) : (
                      [...publicMessages].reverse().map((message) => (
                        <article key={message.id} className="mb-4">
                          <div className="mb-1 flex gap-2 text-2xs text-app-muted">
                            <span>{message.author.display_name}</span>
                            <time dateTime={message.created_at}>
                              {formatTime(message.created_at)}
                            </time>
                          </div>
                          <MessageMarkdown
                            body={message.raw_message}
                            authorKind={message.author.kind}
                          />
                        </article>
                      ))
                    )}
                    {messages.hasNextPage ? (
                      <Button
                        size="compact"
                        tone="ghost"
                        disabled={messages.isFetchingNextPage}
                        onClick={() => void messages.fetchNextPage()}
                      >
                        Load earlier messages
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
            {tab === "Details" && item ? (
              <div className="space-y-5 p-4 text-xs text-app-body">
                <dl className="space-y-3">
                  <Field
                    label="Assignees"
                    value={
                      item.assignees
                        .map((assignment) => assignment.actor.display_name)
                        .join(", ") || "Unassigned"
                    }
                  />
                  <Field label="Priority" value={item.priority} />
                  <Field
                    label="Execution"
                    value={
                      execution
                        ? stageLabels[execution.status]
                        : "Execution is not enabled"
                    }
                  />
                  {execution?.reason_code ? (
                    <Field label="Reason" value={execution.reason_code} />
                  ) : null}
                </dl>
                {item.description ? (
                  <div>
                    <h3 className="mb-2 font-medium">Description</h3>
                    <MessageMarkdown
                      body={item.description}
                      authorKind="human"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function TaskActivityGroup({
  runStatus,
  tenantId,
  roomId,
  visible,
  stopped,
  paused: taskPaused,
  messages,
}: {
  runStatus: TeamHubRunStatus;
  tenantId: string;
  roomId: string;
  visible: boolean;
  stopped: boolean;
  paused: boolean;
  messages: TeamHubMessage[];
}) {
  const active = runStatus.status === "active" && !stopped;
  const paused = runStatus.status === "active" && taskPaused;
  const [opened, setOpened] = useState<boolean>();
  const expanded = opened ?? active;
  const events = useTaskActivityEvents({
    tenantId,
    roomId,
    runStatusId: runStatus.id,
    revision: runStatus.revision,
    enabled: visible && expanded,
  });
  const interrupted =
    (runStatus.status === "aborted" &&
      runStatus.stop_reason !== "task_terminal") ||
    (runStatus.status === "active" && stopped);
  const lifecycle = active
    ? "active"
    : paused
      ? "paused"
      : interrupted
        ? "interrupted"
        : "ended";
  return (
    <div className="border-b border-app-border">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpened(!expanded)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors duration-300 hover:bg-muted/70"
      >
        <ActorAvatar
          actorId={runStatus.agent.id}
          kind="agent"
          name={runStatus.agent.display_name}
          size="xs"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-app-body">
            {runStatus.agent.display_name}
          </span>
          <span className="text-2xs text-app-muted">
            {formatTime(runStatus.created_at)} ·{" "}
            {active
              ? "Working"
              : paused
                ? "Paused"
                : interrupted
                  ? "Interrupted"
                  : "Ended"}
          </span>
        </span>
        {active ? (
          <span
            aria-label="Agent working"
            className="flex h-3.5 items-center text-app-info"
            role="img"
          >
            <RunningDots />
          </span>
        ) : (
          <Icon
            className={expanded ? "rotate-90 text-app-muted" : "text-app-muted"}
            icon={ArrowRight01Icon}
            size={14}
          />
        )}
      </button>
      {expanded ? (
        events.error ? (
          <State>Activity could not be loaded.</State>
        ) : !events.data ? (
          <State busy>Loading activity…</State>
        ) : (
          <RuntimeActivityPath
            records={events.data.items}
            messages={messages}
            lifecycle={lifecycle}
            embedded
          />
        )
      ) : null}
    </div>
  );
}
function State({
  busy = false,
  children,
}: {
  busy?: boolean;
  children: string;
}) {
  if (busy) return <PanelLoading label={children} />;
  return (
    <p className="flex items-center gap-2 px-4 py-5 text-xs leading-5 text-app-muted">
      {children}
    </p>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-app-muted">{label}</dt>
      <dd className="min-w-0 break-words capitalize">{value}</dd>
    </div>
  );
}
function formatTime(value: string) {
  return dateTimeFormat({
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
