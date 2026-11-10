import { cn } from "@/lib/cn";
import { BubbleChatIcon } from "@hugeicons/core-free-icons";
import { Fragment } from "react";
import { Icon } from "@/components/ui/icon";
import type { MeetingOutcome, MeetingTopic } from "./meeting-overview";

/**
 * Topic cards cycle through categorical Nature tints (500 shell at 10%,
 * 700 title); order carries no priority or status.
 */
const topicTints = [
  "bg-bluebell-500/10 text-bluebell-700",
  "bg-rain-500/10 text-rain-700",
  "bg-lichen-500/10 text-lichen-700",
  "bg-sun-500/10 text-sun-700",
  "bg-bubblegum-500/10 text-bubblegum-700",
] as const;

/** Shares the knowledge document's column and H2 around these sections. */
const sectionFrame = "mb-3 w-full";
const sectionHeading =
  "mb-2 mt-7 text-[22px] font-[580] leading-[1.35] tracking-[-0.01em] text-app-ink";

/** Long card text reads better in two columns than three. */
const LONG_TOPIC_TEXT = 120;

/**
 * The Session page's Meeting Summary section, shown in place as one card per
 * topic. The heading matches the knowledge document's H2 around it.
 */
export function MeetingOverviewCard({ topics }: { topics: MeetingTopic[] }) {
  const longTopics = topics.some(
    (topic) =>
      (topic.intro ?? "").length +
        topic.points.map((point) => point.text).join("").length >
      LONG_TOPIC_TEXT,
  );
  return (
    <section
      aria-label="Meeting overview"
      className={cn("@container", sectionFrame)}
    >
      <h2 className={sectionHeading}>Meeting Summary</h2>
      <ol
        aria-label="Topics"
        className={cn(
          "grid grid-cols-1 gap-3 rounded-xl border border-app-border bg-app-surface p-4 md:p-5 @lg:grid-cols-2",
          !longTopics && "@3xl:grid-cols-3",
        )}
      >
        {topics.map((topic, index) => (
          <li
            className={cn(
              "flex flex-col rounded-lg p-1.5",
              topicTints[index % topicTints.length],
            )}
            key={index}
          >
            <div className="flex items-center gap-2 px-2 pb-1.5 pt-1 text-[14px] font-semibold">
              <Icon className="shrink-0" icon={BubbleChatIcon} size={14} />
              <span className="text-xs font-medium tabular-nums opacity-60">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1 break-words">{topic.title}</span>
              {topic.time ? (
                <span className="shrink-0 self-start pt-px text-[12px] font-medium tabular-nums opacity-60">
                  {topic.time}
                </span>
              ) : null}
            </div>
            <div className="flex-1 rounded-md bg-app-surface px-3 py-2.5 text-[14px] leading-relaxed text-app-body">
              {topic.intro ? (
                <p className="text-app-muted">
                  <RichText text={topic.intro} />
                </p>
              ) : null}
              {topic.points.length > 0 ? (
                <ul
                  className={cn(
                    "list-disc space-y-1 pl-4 marker:text-app-muted",
                    topic.intro && "mt-1.5",
                  )}
                >
                  {topic.points.map((point, pointIndex) => (
                    <li key={pointIndex}>
                      <RichText text={point.text} />
                      {point.children.length > 0 ? (
                        <ul className="mt-1 list-[circle] space-y-1 pl-4">
                          {point.children.map((child, childIndex) => (
                            <li key={childIndex}>
                              <RichText text={child} />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The Session page's Keywords as tags. */
export function MeetingKeywords({
  keywords,
  title,
}: {
  keywords: string[];
  title: string;
}) {
  return (
    <section aria-label={title} className={sectionFrame}>
      <h2 className={sectionHeading}>{title}</h2>
      <ul className="flex flex-wrap gap-1.5" aria-label="Keywords">
        {keywords.map((keyword) => (
          <li
            className="rounded-full border border-app-border bg-app-surface px-2.5 py-0.5 text-[14px] leading-5 text-app-body"
            key={keyword}
          >
            {keyword}
          </li>
        ))}
      </ul>
    </section>
  );
}

const outcomeTints: Record<NonNullable<MeetingOutcome["label"]>, string> = {
  Decision: "border-app-info/30 bg-app-info/10 text-app-info",
  Completed:
    "border-(--app-status-success-border) bg-(--app-status-success-surface) text-(--app-status-success-text)",
  Action:
    "border-(--app-status-warning-border) bg-(--app-status-warning-surface) text-(--app-status-warning-text)",
};

/**
 * Decisions And Outcomes or Action Items, each entry led by its kind as a
 * tag instead of the `Decision:` / `Completed:` / `Action:` prefix.
 */
export function MeetingOutcomes({
  outcomes,
  title,
}: {
  outcomes: MeetingOutcome[];
  title: string;
}) {
  return (
    <section aria-label={title} className={sectionFrame}>
      <h2 className={sectionHeading}>{title}</h2>
      {outcomes.length === 0 ? (
        <p className="text-[15px] leading-relaxed text-app-body">
          None observed.
        </p>
      ) : null}
      <ul className="space-y-2.5 text-[15px] leading-relaxed text-app-body">
        {outcomes.map((item, index) => (
          <li className="flex items-start gap-2.5" key={index}>
            {item.label ? (
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded-md border px-1.5 text-[12px] font-medium leading-5",
                  outcomeTints[item.label],
                )}
              >
                {item.label}
              </span>
            ) : null}
            <div className="min-w-0">
              <RichText text={item.text} />
              {item.children.length > 0 ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[14px] text-app-muted marker:text-app-muted">
                  {item.children.map((child, childIndex) => (
                    <li key={childIndex}>
                      <RichText text={child} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Plain text with the `**bold**` emphasis the Session page carries. */
function RichText({ text }: { text: string }) {
  return text.split(/\*\*(.+?)\*\*/gu).map((part, index) =>
    index % 2 === 1 ? (
      <strong className="font-semibold text-app-ink" key={index}>
        {part}
      </strong>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}
