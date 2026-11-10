import {
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  Clock01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import type { CSSProperties, ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceFileIcon } from "@/features/library/workspace-file-icon";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import { RoomAvatar } from "@/features/rooms/members/room-avatar";
import { markdownPlainText } from "@/features/teamhub/markdown-plain-text";

import {
  resultTarget,
  SCOPES,
  type GroupTab,
  type SearchResult,
  type TargetContext,
} from "./global-search-model";
import type { SearchTarget } from "./global-search-recent";
import { HighlightedText } from "./search-highlight";
import { relativeTimeLabel, snippetAround } from "./search-text";

export function EmptyState({
  action,
  detail,
  title,
  tone = "muted",
}: {
  action?: { label: string; onSelect: () => void };
  detail: string;
  title: string;
  tone?: "danger" | "muted";
}) {
  return (
    <div
      className="global-search-enter flex h-full flex-col items-center justify-center gap-1 px-6 text-center"
      role={tone === "danger" ? "alert" : "status"}
    >
      <span className="mb-2 grid size-10 place-items-center rounded-xl bg-(--app-field-surface) text-muted-foreground shadow-outline">
        <Icon icon={Search01Icon} size={20} />
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p
        className={`text-sm ${tone === "danger" ? "text-app-danger" : "text-muted-foreground"}`}
      >
        {detail}
      </p>
      {action ? (
        <button
          className="mt-3 h-8 rounded-full border border-border px-3 text-xs font-medium text-foreground transition-colors duration-150 hover:border-foreground/15 hover:bg-accent"
          onClick={action.onSelect}
          type="button"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/** Placeholder rows with the real row geometry, so results replace them in place. */
export function SkeletonRows() {
  return (
    <div aria-hidden>
      {["w-2/5", "w-1/3", "w-1/2"].map((width) => (
        <div className="flex h-[52px] items-center gap-3 px-3" key={width}>
          <Skeleton className="size-8 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className={`h-2.5 ${width}`} />
            <Skeleton className="h-2 w-3/4" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function ScopeCard({
  active,
  highlighted,
  index,
  onActivate,
  onOpen,
  tab,
}: {
  active: boolean;
  highlighted: boolean;
  index: number;
  onActivate: () => void;
  onOpen: () => void;
  tab: GroupTab;
}) {
  const scope = SCOPES[tab];
  return (
    <button
      aria-selected={active}
      className={`global-search-enter group/scope grid h-14 grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-2.5 text-left transition-colors duration-150 ${
        highlighted
          ? "border-app-border-strong bg-app-hover"
          : "border-app-border hover:border-app-border-strong hover:bg-app-hover"
      }`}
      id={`global-search-result-${index}`}
      onClick={onOpen}
      onMouseMove={onActivate}
      role="option"
      style={{ "--enter-index": index } as CSSProperties}
      type="button"
    >
      <span className="grid size-9 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon icon={scope.icon} size={16} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-app-ink">
          {scope.label}
        </span>
        <span className="block truncate text-xs text-app-muted">
          {scope.hint}
        </span>
      </span>
      <Icon
        className={`text-muted-foreground transition-[opacity,transform] duration-[var(--app-micro-duration)] ${
          highlighted ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0"
        } group-hover/scope:translate-x-0 group-hover/scope:opacity-100`}
        icon={ArrowRight01Icon}
        size={14}
      />
    </button>
  );
}

export function ResultRow({
  active,
  context,
  highlighted,
  enterIndex,
  index,
  onActivate,
  onOpen,
  query,
  result,
}: {
  active: boolean;
  context: TargetContext;
  highlighted: boolean;
  enterIndex: number;
  index: number;
  onActivate: () => void;
  onOpen: () => void;
  query: string;
  result: SearchResult;
}) {
  if (result.kind === "scope") return null;
  const target =
    result.kind === "query" ? undefined : resultTarget(result, context);
  const meta =
    target?.kind === "message"
      ? relativeTimeLabel(target.createdAt)
      : target?.kind === "document"
        ? relativeTimeLabel(target.updatedAt)
        : "";
  return (
    <button
      aria-selected={active}
      className={`global-search-enter relative z-[1] grid w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-sm px-3 text-left ${
        result.kind === "query" ? "h-10" : "h-[52px]"
      }`}
      data-row
      id={`global-search-result-${index}`}
      onClick={onOpen}
      onMouseMove={onActivate}
      role="option"
      style={{ "--enter-index": enterIndex } as CSSProperties}
      type="button"
    >
      {result.kind === "query" ? (
        <>
          <span className="grid size-8 place-items-center text-app-subtle">
            <Icon
              className="global-search-query-glyph"
              icon={Clock01Icon}
              size={14}
            />
          </span>
          <span className="truncate text-sm text-app-ink">{result.text}</span>
        </>
      ) : (
        <TargetRowContent
          query={query}
          target={target!}
          text={
            result.kind === "message"
              ? markdownPlainText(result.hit.message.raw_message)
              : undefined
          }
        />
      )}
      <span className="grid min-w-10 justify-items-end">
        <span
          className={`col-start-1 row-start-1 text-xs tabular-nums text-app-subtle transition-opacity duration-[var(--app-micro-duration)] ${
            highlighted ? "opacity-0" : "opacity-100"
          }`}
        >
          {meta}
        </span>
        <span
          className={`col-start-1 row-start-1 transition-[opacity,transform] duration-[var(--app-micro-duration)] ${
            highlighted
              ? "translate-x-0 opacity-100"
              : "translate-x-1 opacity-0"
          }`}
        >
          <ShortcutKey>
            <Icon icon={ArrowTurnBackwardIcon} size={12} />
          </ShortcutKey>
        </span>
      </span>
    </button>
  );
}

/** Tile and two text lines for a live hit. */
function TargetRowContent({
  query,
  target,
  text,
}: {
  query: string;
  target: SearchTarget;
  /** A live Message's full text; a stored entry only keeps a preview. */
  text?: string;
}) {
  const [title, detail] = rowLines(target, query, text);
  return (
    <>
      <TargetTile target={target} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium leading-5 text-app-ink">
          <span className="truncate">
            {target.kind === "message" ? (
              target.author.name
            ) : (
              <HighlightedText query={query} text={title} />
            )}
          </span>
          {target.kind === "message" ? (
            <span className="shrink-0 truncate text-xs text-muted-foreground">
              in {target.roomLabel}
            </span>
          ) : null}
          {target.kind === "agent" ? <AgentTag /> : null}
        </span>
        <span
          className={`truncate text-xs leading-[18px] ${
            target.kind === "message" ? "text-app-body" : "text-app-subtle"
          }`}
        >
          <HighlightedText query={query} text={detail} />
        </span>
      </span>
    </>
  );
}

function rowLines(
  target: SearchTarget,
  query: string,
  text?: string,
): [string, string] {
  switch (target.kind) {
    case "message":
      // The line opens a few characters before the match, so the highlighted
      // word stays inside the single visible line however late it appears.
      return [
        target.author.name,
        snippetAround(text ?? target.text, query, 120, 12),
      ];
    case "document":
      return [target.fileName, `${target.location} · ${target.ownerName}`];
    case "agent":
      return [target.name, target.description || "No description yet"];
    case "room":
      return [
        target.roomKind === "room" ? `#${target.name}` : target.name,
        target.description ||
          (target.roomKind === "thread"
            ? `#${target.parentName ?? ""} · thread`
            : "Room"),
      ];
  }
}

/** The 32px identity tile every row starts with. */
function TargetTile({ target }: { target: SearchTarget }) {
  switch (target.kind) {
    case "message":
      return (
        <ActorAvatar
          actorId={target.author.id}
          kind={target.author.kind}
          name={target.author.name}
          size="nav"
        />
      );
    case "document":
      return (
        <span className="grid size-8 shrink-0 place-items-center">
          <WorkspaceFileIcon compact filename={target.fileName} />
        </span>
      );
    case "agent":
      return (
        <ActorAvatar
          actorId={target.id}
          avatarKey={target.avatarKey}
          kind="agent"
          name={target.name}
          size="nav"
        />
      );
    case "room":
      // Mirrors the Room sidebar: the member mosaic, which for a thread
      // previews its parent's members.
      return (
        <RoomAvatar
          members={(target.members ?? []).map((member) => ({
            display_name: member.name,
            id: member.id,
            kind: member.kind,
          }))}
          size="header"
        />
      );
  }
}

function AgentTag() {
  return (
    <span className="shrink-0 rounded-full bg-(--app-mention-surface) px-1.5 text-xs leading-[18px] font-medium text-(--app-mention-text)">
      Agent
    </span>
  );
}

export function ShortcutKey({ children }: { children: ReactNode }) {
  return (
    <kbd className="grid h-5 min-w-5 place-items-center rounded-md border border-app-border-strong border-b-2 bg-app-surface px-1 font-sans text-[12px] font-medium text-app-muted">
      {children}
    </kbd>
  );
}
