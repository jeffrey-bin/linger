import {
  ArrowRight01Icon,
  BubbleChatIcon,
  CheckListIcon,
  Loading03Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HeadlessMantineProvider, Spoiler } from "@mantine/core";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  TeamHubMessage,
  TeamHubRuntimePresentationEventRecord,
} from "@/features/teamhub/teamhub-types";

import { MessageMarkdown } from "../chat/message-markdown";
import {
  projectRuntimeActivityPath,
  type RuntimeActivityPathItem,
  type RuntimeActivityLifecycle,
  type RuntimeActivityPathToolCall,
} from "./runtime-activity-path";
import { RuntimeActivityEntries } from "./runtime-activity-entries";
import {
  toolGroupPresentation,
  toolPresentation,
} from "./runtime-tool-presentation";

const EMPTY_MESSAGES: readonly TeamHubMessage[] = [];

export function RuntimeActivityPath({
  messages = EMPTY_MESSAGES,
  records,
  lifecycle = "active",
  embedded = false,
}: {
  messages?: readonly TeamHubMessage[];
  lifecycle?: RuntimeActivityLifecycle;
  embedded?: boolean;
  records: readonly TeamHubRuntimePresentationEventRecord[];
}) {
  const items = useMemo(
    () =>
      projectRuntimeActivityPath(records, replyTextById(messages), lifecycle),
    [messages, records, lifecycle],
  );
  const containerRef = useRef<HTMLOListElement>(null);
  const shouldFollowLatestRef = useRef(true);
  const [showEarlier, setShowEarlier] = useState(false);
  const latestKey = items.at(-1)?.key;
  const conciseItems = useMemo(() => compactActivityItems(items), [items]);
  const recentItems = conciseItems.slice(-8);
  const latestPlan = [...conciseItems]
    .reverse()
    .find((item) => item.kind === "plan");
  const pinnedPlan =
    latestPlan && !recentItems.some((item) => item.key === latestPlan.key)
      ? [latestPlan]
      : [];
  const earlierCount = Math.max(
    0,
    items.length - recentItems.length - pinnedPlan.length,
  );
  const visibleItems = showEarlier ? items : [...pinnedPlan, ...recentItems];

  useEffect(() => {
    if (embedded || !shouldFollowLatestRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const animationFrame = requestAnimationFrame(() => {
      if (!container.lastElementChild) return;
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const top = Math.max(0, container.scrollHeight - container.clientHeight);
      if (typeof container.scrollTo === "function") {
        container.scrollTo({
          behavior: reduceMotion ? "auto" : "smooth",
          top,
        });
        return;
      }
      container.scrollTop = top;
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [latestKey, items.length, showEarlier, embedded]);

  return (
    <ol
      aria-label="Activity log"
      className={
        embedded
          ? "space-y-2 bg-card px-4 py-3 text-xs leading-5 text-app-muted"
          : "workspace-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain bg-card px-4 py-3 text-xs font-normal leading-5 text-app-muted"
      }
      onScroll={(event) => {
        const container = event.currentTarget;
        shouldFollowLatestRef.current =
          container.scrollHeight -
            container.scrollTop -
            container.clientHeight <=
          32;
      }}
      ref={containerRef}
    >
      {earlierCount > 0 || showEarlier ? (
        <li className="pb-1">
          <button
            className="inline-flex min-h-7 items-center rounded-md px-1 text-[12px] font-medium text-app-muted hover:bg-app-hover hover:text-app-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-focus"
            onClick={() => {
              const next = !showEarlier;
              shouldFollowLatestRef.current = !next;
              setShowEarlier(next);
            }}
            type="button"
          >
            {showEarlier
              ? "Show less activity"
              : `Show all activity (${earlierCount} more)`}
          </button>
        </li>
      ) : null}
      {visibleItems.map((item) => (
        <RuntimeActivityPathRow item={item} key={item.key} />
      ))}
    </ol>
  );
}

function compactActivityItems(
  items: readonly RuntimeActivityPathItem[],
): RuntimeActivityPathItem[] {
  const lastReplyKey = [...items]
    .reverse()
    .find((item) => item.kind === "reply")?.key;
  const concise: RuntimeActivityPathItem[] = [];
  for (const item of items) {
    if (item.kind === "reply" && item.key !== lastReplyKey) continue;
    if (item.kind === "tool_calls" && isSuccessfulMessageOnlyGroup(item)) {
      continue;
    }
    const previous = concise.at(-1);
    if (
      previous &&
      isRepeatableActivityItem(item) &&
      isRepeatableActivityItem(previous) &&
      activityItemLabel(previous) === activityItemLabel(item)
    ) {
      concise[concise.length - 1] = item;
      continue;
    }
    concise.push(item);
  }
  return concise;
}

function isSuccessfulMessageOnlyGroup(
  item: Extract<RuntimeActivityPathItem, { kind: "tool_calls" }>,
) {
  return (
    item.calls.length > 0 &&
    item.calls.every((call) => {
      const presentation = toolPresentation(call.kind);
      return (
        presentation.category === "message" &&
        call.outcome !== "failed" &&
        !call.unconfirmed
      );
    })
  );
}

function isRepeatableActivityItem(item: RuntimeActivityPathItem) {
  return ["command", "activity", "tool_calls", "reply"].includes(item.kind);
}

function activityItemLabel(item: RuntimeActivityPathItem): string {
  if (item.kind === "command") {
    return toolPresentation("command").summary;
  }
  if (item.kind === "activity") {
    return toolPresentation(item.activityKind).summary;
  }
  if (item.kind === "tool_calls") {
    return toolGroupPresentation(
      item.calls.map((call) => toolPresentation(call.kind)),
    ).label;
  }
  if (item.kind === "reply") return "Prepared a reply";
  return item.kind;
}

function RuntimeActivityPathRow({ item }: { item: RuntimeActivityPathItem }) {
  if (item.kind === "thinking") {
    return (
      <li className="runtime-activity-step flex min-h-8 items-start gap-2 py-1.5">
        <Icon
          icon={SparklesIcon}
          className="mt-0.5 shrink-0 text-app-muted"
          size={14}
        />
        <ThinkingText>
          <div className="whitespace-pre-wrap break-words leading-5">
            {item.title}
            {item.active ? (
              <span aria-hidden="true" className="town-caret" />
            ) : null}
          </div>
        </ThinkingText>
        {item.active ? <ActiveMark /> : null}
      </li>
    );
  }
  if (item.kind === "command") {
    const presentation = toolPresentation("command");
    return (
      <ActivitySummaryRow
        active={item.active}
        unconfirmed={item.unconfirmed}
        entries={item.entries}
        icon={presentation.glyph}
        summary={presentation.summary}
      />
    );
  }
  if (item.kind === "activity") {
    const presentation = toolPresentation(item.activityKind);
    return (
      <ActivitySummaryRow
        active={item.active}
        unconfirmed={item.unconfirmed}
        entries={item.entries}
        icon={presentation.glyph}
        summary={presentation.summary}
      />
    );
  }
  if (item.kind === "tool_calls") {
    return <ToolCallsRow calls={item.calls} />;
  }
  if (item.kind === "plan") {
    return <PlanRow item={item} />;
  }
  if (item.kind === "reply") {
    return <ReplyRow text={item.text} />;
  }
  return (
    <li className="runtime-activity-step py-1.5">
      <p className={item.tone === "failed" ? "text-app-danger" : undefined}>
        {item.text}
      </p>
    </li>
  );
}

function ActivitySummaryRow({
  active,
  unconfirmed,
  entries,
  icon,
  summary,
}: {
  active: boolean;
  unconfirmed?: boolean;
  entries: RuntimeActivityPathToolCall["entries"];
  icon: IconSvgElement;
  summary: string;
}) {
  const line = (
    <>
      <Icon className="shrink-0" icon={icon} size={14} />
      <span
        className={`min-w-0 flex-1 truncate ${active ? "town-shimmer-text" : ""}`}
        title={summary}
      >
        {summary}
      </span>
      {active ? <ActiveMark /> : null}
      {unconfirmed ? (
        <span className="text-[10px] text-app-muted">Unconfirmed</span>
      ) : null}
      {entries.length > 0 ? (
        <Icon
          icon={ArrowRight01Icon}
          className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          size={14}
        />
      ) : null}
    </>
  );
  if (entries.length === 0) {
    return (
      <li className="runtime-activity-step flex min-h-8 items-center gap-2 py-1.5">
        {line}
      </li>
    );
  }
  return (
    <li className="runtime-activity-step">
      <details className="group">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 py-1.5 hover:text-app-body focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus [&::-webkit-details-marker]:hidden">
          {line}
        </summary>
        <div className="pb-2 pl-[1.45rem]">
          <RuntimeActivityEntries entries={entries} title={summary} />
        </div>
      </details>
    </li>
  );
}

function ToolCallsRow({
  calls,
}: {
  calls: readonly RuntimeActivityPathToolCall[];
}) {
  const active = calls.some((call) => call.active);
  const presentedCalls = calls.map((call) => {
    return {
      ...call,
      ...toolPresentation(call.kind),
    };
  });
  const { glyph: groupGlyph, label } = toolGroupPresentation(presentedCalls);
  return (
    <li className="runtime-activity-step">
      <details className="group">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 py-1.5 hover:text-app-body focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus [&::-webkit-details-marker]:hidden">
          <span className="relative inline-flex size-[15px] shrink-0 items-center justify-center">
            <Icon
              className="absolute inset-0 m-auto group-hover:hidden group-focus-within:hidden group-open:hidden"
              icon={groupGlyph}
              size={14}
            />
            <Icon
              icon={ArrowRight01Icon}
              className="absolute inset-0 m-auto hidden group-hover:block group-focus-within:block group-open:block group-open:rotate-90 motion-reduce:transition-none"
              size={14}
            />
          </span>
          <span
            className={`min-w-0 flex-1 truncate ${active ? "town-shimmer-text" : ""}`}
            title={label}
          >
            {label}
          </span>
          {active ? <ActiveMark /> : null}
        </summary>
        <ul className="space-y-1 pb-2 pl-[1.45rem]">
          {presentedCalls.map((call) => {
            const { glyph, label } = call;
            const name = (
              <>
                <span
                  aria-label={label}
                  className="inline-flex shrink-0"
                  role="img"
                >
                  <Icon icon={glyph} size={14} />
                </span>
                <span
                  className="min-w-0 flex-1 truncate"
                  title={`${label}: ${call.name}`}
                >
                  {call.summary}
                </span>
                {call.active ? <ActiveMark /> : null}
                {call.unconfirmed ? (
                  <span className="text-[10px] text-app-muted">
                    Unconfirmed
                  </span>
                ) : null}
              </>
            );
            if (call.entries.length === 0) {
              return (
                <li className="flex min-h-7 items-center gap-2" key={call.id}>
                  {name}
                </li>
              );
            }
            return (
              <li className="min-w-0" key={call.id}>
                <details className="group/tool">
                  <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 py-0.5 hover:text-app-body focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus [&::-webkit-details-marker]:hidden">
                    {name}
                  </summary>
                  <RuntimeActivityEntries
                    entries={call.entries}
                    title={`${label}: ${call.name}`}
                  />
                </details>
              </li>
            );
          })}
        </ul>
      </details>
    </li>
  );
}

function ReplyRow({ text }: { text: string }) {
  return (
    <li className="runtime-activity-step py-1.5">
      <details className="group/reply">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 hover:text-app-body focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus [&::-webkit-details-marker]:hidden">
          <Icon icon={BubbleChatIcon} className="shrink-0" size={14} />
          <span className="min-w-0 flex-1 truncate">Prepared a reply</span>
          <Icon
            icon={ArrowRight01Icon}
            className="shrink-0 transition-transform group-open/reply:rotate-90 motion-reduce:transition-none"
            size={14}
          />
        </summary>
        <div className="pb-2 pl-[1.45rem] pt-1 text-app-body">
          <MessageMarkdown authorKind="agent" body={text} />
        </div>
      </details>
    </li>
  );
}

function PlanRow({
  item,
}: {
  item: Extract<RuntimeActivityPathItem, { kind: "plan" }>;
}) {
  return (
    <li className="runtime-activity-step py-1.5">
      <div className="flex min-h-8 items-center gap-2">
        <Icon icon={CheckListIcon} className="shrink-0" size={14} />
        <span className="min-w-0 flex-1 truncate">Plan</span>
      </div>
      {item.explanation ? (
        <p className="whitespace-pre-wrap break-words pb-1 pl-[1.45rem]">
          {item.explanation}
        </p>
      ) : null}
      <ol aria-label="Run plan" className="space-y-1 pb-1 pl-[1.45rem]">
        {item.steps.map((step) => (
          <li
            className="flex min-w-0 items-start gap-2"
            key={`${step.status}:${step.content}`}
          >
            <PlanMark status={step.status} />
            <span className="min-w-0 break-words">{step.content}</span>
          </li>
        ))}
      </ol>
    </li>
  );
}

function PlanMark({
  status,
}: {
  status: Extract<
    RuntimeActivityPathItem,
    { kind: "plan" }
  >["steps"][number]["status"];
}) {
  if (status === "in_progress") {
    return (
      <Icon
        icon={Loading03Icon}
        className="mt-1 shrink-0 animate-spin text-app-info"
        size={12}
      />
    );
  }
  return (
    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-app-border-strong" />
  );
}

// Spoiler owns measurement, resize updates, disclosure state and ARIA wiring.
// Headless mode keeps the existing app styles and avoids global Mantine CSS.
function ThinkingText({ children }: { children: ReactNode }) {
  return (
    <HeadlessMantineProvider>
      <Spoiler
        className="flex min-w-0 flex-1 flex-col items-start [--mantine-scale:1]"
        classNames={{
          content: "order-first w-full overflow-hidden",
          control:
            "mt-1 inline-flex min-h-7 items-center rounded-md px-1 text-xs font-medium text-app-muted hover:bg-app-hover hover:text-app-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-focus",
        }}
        hideLabel="Show less"
        maxHeight={40}
        showLabel="Show more"
      >
        {children}
      </Spoiler>
    </HeadlessMantineProvider>
  );
}

function replyTextById(messages: readonly TeamHubMessage[]) {
  return new Map(
    messages.map((message) => [message.id, message.raw_message.trim()]),
  );
}

function ActiveMark() {
  return (
    <span
      aria-label="In progress"
      className="town-dots shrink-0 text-app-muted"
      role="img"
    >
      <span />
      <span />
      <span />
    </span>
  );
}
