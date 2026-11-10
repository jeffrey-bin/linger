import {
  ArrowDown01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  PencilEdit01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { AutoHeight } from "@/components/ui/auto-height";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

/**
 * One row in a card's box: a 32px muted icon square, one truncated line and
 * an optional 12px second line. With `onToggle` the row is a button that
 * opens and closes what sits under it.
 */
export function CardRow({
  detail,
  icon,
  onToggle,
  open = false,
  title,
  trailing,
}: {
  detail?: ReactNode;
  icon: ReactNode;
  onToggle?: () => void;
  open?: boolean;
  title: ReactNode;
  trailing?: ReactNode;
}) {
  const body = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center [&>svg]:size-6 [&>img]:size-7 text-app-ink">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-app-ink">{title}</span>
        {detail ? (
          <span className="block truncate text-xs text-app-muted">
            {detail}
          </span>
        ) : null}
      </span>
      {onToggle ? (
        <Icon
          className={cn(
            "shrink-0 text-app-muted transition-transform duration-(--chat-resize-duration) ease-(--app-out-quint) motion-reduce:transition-none",
            open && "rotate-180",
          )}
          icon={ArrowDown01Icon}
          size={14}
        />
      ) : null}
      {trailing}
    </>
  );
  const rowClassName =
    "flex w-full min-w-0 items-center gap-2.5 rounded-lg p-2 text-left";
  return onToggle ? (
    <button
      aria-expanded={open}
      className={cn(
        rowClassName,
        "transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus motion-reduce:transition-none",
      )}
      onClick={onToggle}
      type="button"
    >
      {body}
    </button>
  ) : (
    <div className={rowClassName}>{body}</div>
  );
}

/** What a card's row opens to: the full view TeamHub froze. */
/**
 * What a card row's toggle reveals. It eases open and shut; once opened it
 * stays mounted so closing can ease too.
 */
export function CardRowDetails({
  children,
  open,
}: {
  children: ReactNode;
  open: boolean;
}) {
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  if (!shown) return null;
  return (
    <AutoHeight appear open={open}>
      <div className="flex flex-col gap-2 pt-1 pb-2">{children}</div>
    </AutoHeight>
  );
}

/** The buttons at the bottom of a card's box. */
export function CardActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-2">{children}</div>
  );
}

/** Why the last action did not go through. */
export function CardError({ children }: { children: ReactNode }) {
  return (
    <p
      className="pb-2 [overflow-wrap:anywhere] text-xs text-app-danger"
      role="alert"
    >
      {children}
    </p>
  );
}

const subtleControl =
  "bg-secondary transition-colors duration-150 hover:bg-primary/[0.09] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-focus disabled:opacity-45 motion-reduce:transition-none";

/**
 * Approve, or the soft deny beside it. The pencil next to deny turns it into
 * a reason field in place (approve shrinks to a check mark to make room);
 * pressing it again returns to a plain deny and keeps the draft. When a
 * denial needs a reason, deny opens the field and only a written reason
 * denies.
 */
export function DecisionActions({
  approveLabel = "Approve",
  denyLabel = "Deny",
  disabled,
  onApprove,
  onDeny,
  reasonRequired = false,
}: {
  approveLabel?: string;
  denyLabel?: string;
  disabled: boolean;
  onApprove: () => void;
  onDeny: (reason?: string) => void;
  reasonRequired?: boolean;
}) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const hasDraft = draft.trim() !== "";
  const toggleLabel = composing
    ? reasonRequired
      ? "Close the reason"
      : "Deny without a reason"
    : hasDraft
      ? "Continue your reason"
      : "Add a reason";

  function deny(reason?: string) {
    if (reasonRequired && !reason) {
      setComposingAndFocus(true);
      return;
    }
    onDeny(reason);
  }

  function setComposingAndFocus(next: boolean) {
    flushSync(() => setComposing(next));
    if (next) inputRef.current?.focus({ preventScroll: true });
    else toggleRef.current?.focus({ preventScroll: true });
  }

  function onReasonKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter while an input method is composing picks a candidate.
    if (
      event.key === "Enter" &&
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      deny(draft.trim());
    } else if (event.key === "Escape") {
      event.preventDefault();
      setComposingAndFocus(false);
    }
  }

  return (
    <div
      aria-label="Approval actions"
      className={cn(
        "grid w-full gap-2 transition-[grid-template-columns] duration-[var(--app-emphasized-duration)] ease-[var(--app-out-quint)] motion-reduce:transition-none",
        composing
          ? "grid-cols-[0fr_1fr]"
          : "grid-cols-[auto_auto] justify-start",
      )}
      role="group"
    >
      <Button
        aria-label={approveLabel}
        className="group/tip w-full"
        disabled={disabled}
        onClick={onApprove}
        size={composing ? "icon" : "default"}
        tone="primary"
      >
        {composing ? (
          <>
            <Icon icon={Tick02Icon} size={14} />
            <HoverTip align="start">{approveLabel}</HoverTip>
          </>
        ) : (
          approveLabel
        )}
      </Button>
      <div className="flex min-w-0 gap-px">
        <div className="grid min-w-0 flex-1">
          {/* Each layer hides on its own wrapper: the controls inside carry
              disabled:opacity, which would otherwise show a hidden layer. */}
          <div
            className={cn(
              "col-start-1 row-start-1 flex transition-opacity duration-[var(--app-floating-duration)] motion-reduce:transition-none",
              composing && "pointer-events-none opacity-0",
            )}
            data-testid="deny-plain-layer"
            inert={composing}
          >
            {/* Not the shared Button: its size class sets the radius outside
                Tailwind's layers, so a square right edge would be dropped. */}
            <button
              className={cn(
                "inline-flex h-9 w-full items-center justify-center whitespace-nowrap rounded-l-lg px-4 text-sm font-medium text-secondary-foreground",
                subtleControl,
              )}
              disabled={disabled}
              onClick={() => deny()}
              type="button"
            >
              {denyLabel}
            </button>
          </div>
          <div
            className={cn(
              "col-start-1 row-start-1 flex h-9 min-w-0 items-center gap-1 rounded-l-lg bg-secondary pr-1 pl-4 transition-opacity duration-[var(--app-floating-duration)] motion-reduce:transition-none",
              !composing && "pointer-events-none opacity-0",
            )}
            data-testid="deny-reason-layer"
            inert={!composing}
          >
            <input
              aria-label="Reason for denying"
              className="h-full w-0 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onReasonKeyDown}
              placeholder="Reason, then press Enter"
              ref={inputRef}
              value={draft}
            />
            <button
              aria-label="Deny with this reason"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-app-focus disabled:opacity-45"
              disabled={disabled || (reasonRequired && !hasDraft)}
              onClick={() => deny(draft.trim())}
              type="button"
            >
              <Icon icon={ArrowUp02Icon} size={14} />
            </button>
          </div>
        </div>
        <button
          aria-label={toggleLabel}
          aria-pressed={composing}
          className={cn(
            "group/tip relative inline-flex size-9 shrink-0 items-center justify-center rounded-r-lg",
            subtleControl,
            composing ? "text-app-ink" : "text-app-muted",
          )}
          disabled={disabled}
          onClick={() => setComposingAndFocus(!composing)}
          ref={toggleRef}
          type="button"
        >
          {composing ? (
            <Icon icon={Cancel01Icon} size={14} />
          ) : (
            <Icon icon={PencilEdit01Icon} size={14} />
          )}
          {hasDraft && !composing ? (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-app-ink"
            />
          ) : null}
          <HoverTip align="end">{toggleLabel}</HoverTip>
        </button>
      </div>
    </div>
  );
}

/**
 * A hover and keyboard-focus label for an icon button; its parent is
 * `group/tip`. The name matters: the timeline's message row is a plain
 * `group`, and hovering it must not show every label in the card.
 */
function HoverTip({
  align,
  children,
}: {
  align: "end" | "start";
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute bottom-[calc(100%+6px)] z-20 whitespace-nowrap rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground opacity-0 transition-opacity duration-150 group-hover/tip:opacity-100 group-hover/tip:delay-200 group-focus-visible/tip:opacity-100 motion-reduce:transition-none ${align === "start" ? "left-0" : "right-0"}`}
    >
      {children}
    </span>
  );
}

/** A titled, bordered block under an approval card's Details. */
export function DetailBlock({
  children,
  label,
}: {
  children: ReactNode;
  label: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border">
      <h4 className="border-b border-border bg-muted/50 px-3 py-1.5 [overflow-wrap:anywhere] text-xs font-medium text-muted-foreground">
        {label}
      </h4>
      {children}
    </section>
  );
}

/** The full call as a block; JSON arguments are indented for reading. */
export function FullCallBlock({
  input,
  tool,
}: {
  input: string;
  tool: string;
}) {
  return (
    <DetailBlock label={<>Full call · {tool}</>}>
      <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs leading-5 text-app-ink">
        {formatInput(input)}
      </pre>
    </DetailBlock>
  );
}

function formatInput(input: string) {
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // A shell command is not JSON; show it as written.
  }
  return input;
}
