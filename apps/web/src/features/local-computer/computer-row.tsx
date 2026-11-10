import { ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";

import { Icon, type IconSvgElement } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

import { Hint } from "./computer-hint";

/** The building blocks the Computers list and detail share. */

export function StatusDot({
  tone,
}: {
  tone: "neutral" | "success" | "warning";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "success"
          ? "bg-app-success"
          : tone === "warning"
            ? "bg-app-warning"
            : "bg-muted-foreground/50",
      )}
    />
  );
}

/** One step of the summary; only a step the user can act on is a button. */
export function ProgressChip({
  attentionIcon,
  hint,
  icon,
  label,
  onClick,
  state,
}: {
  /** The badge an attention chip carries, naming what the step asks for. */
  attentionIcon?: IconSvgElement;
  hint: string;
  icon: IconSvgElement;
  label: string;
  onClick?: () => void;
  state: "attention" | "done" | "optional";
}) {
  const className = cn(
    "inline-flex h-7 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-xs transition-colors duration-150",
    state === "attention"
      ? "bg-[var(--app-status-warning-surface)] text-app-warning"
      : state === "optional"
        ? "text-muted-foreground shadow-[inset_0_0_0_1px_var(--color-border-hover)]"
        : "bg-muted text-secondary-foreground",
    onClick && "hover:brightness-95",
  );
  const content = (
    <>
      <Icon icon={icon} size={14} />
      {label}
      {state === "done" ? (
        <StateBadge tone="success" icon={Tick02Icon} />
      ) : state === "attention" && attentionIcon ? (
        <StateBadge tone="warning" icon={attentionIcon} />
      ) : null}
    </>
  );
  return (
    <Hint focusable placement="bottom" text={hint}>
      {onClick ? (
        <button className={className} onClick={onClick} type="button">
          {content}
        </button>
      ) : (
        <span className={className}>{content}</span>
      )}
    </Hint>
  );
}

function StateBadge({
  icon,
  tone,
}: {
  icon: IconSvgElement;
  tone: "success" | "warning";
}) {
  return (
    <span
      className={cn(
        "flex size-3.5 items-center justify-center rounded-full text-white",
        tone === "success" ? "bg-app-success" : "bg-app-warning",
      )}
    >
      <Icon icon={icon} size={10} />
    </span>
  );
}

/** A Chats-list style row: a 36px mark, a name, one line of state, one action. */
export function ComputerRow({
  action,
  dimmed = false,
  hint,
  mark,
  onClick,
  subtitle,
  title,
}: {
  action?: ReactNode;
  dimmed?: boolean;
  hint?: string;
  mark: ReactNode;
  onClick?: () => void;
  subtitle: ReactNode;
  title: ReactNode;
}) {
  const body = (
    <>
      <span
        className={cn("relative shrink-0", dimmed && "opacity-50 grayscale")}
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span
          className={cn(
            "block truncate text-sm",
            dimmed ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
        </span>
        <span className="block truncate text-sm text-muted-foreground">
          {subtitle}
        </span>
      </span>
    </>
  );
  const row = onClick ? (
    <button
      className="flex min-h-14 w-full items-center gap-3 rounded-lg py-2 pr-2.5 pl-2 transition-colors duration-150 hover:bg-sidebar-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
      onClick={onClick}
      type="button"
    >
      {body}
      {action ?? (
        <Icon
          className="text-muted-foreground/60"
          icon={ArrowRight01Icon}
          size={16}
        />
      )}
    </button>
  ) : (
    <div className="flex min-h-14 w-full items-center gap-3 rounded-lg py-2 pr-2.5 pl-2">
      {body}
      {action}
    </div>
  );
  return hint ? (
    <Hint className="flex" text={hint}>
      {row}
    </Hint>
  ) : (
    row
  );
}

export function RowMark({
  children,
  dashed = false,
}: {
  children: ReactNode;
  dashed?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex size-9 items-center justify-center rounded-[20%]",
        dashed
          ? "text-muted-foreground shadow-[inset_0_0_0_1px_var(--color-border-hover)]"
          : "bg-muted text-foreground",
      )}
    >
      {children}
    </span>
  );
}
