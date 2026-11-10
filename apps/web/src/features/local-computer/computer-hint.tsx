import { type ReactNode, useId, useState } from "react";

import { cn } from "@/lib/cn";

/**
 * Explanations on this page appear on hover or keyboard focus, so the page
 * itself only carries names, one-line states and actions.
 */
export function Hint({
  children,
  className,
  focusable = false,
  placement = "top",
  text,
}: {
  children: ReactNode;
  className?: string;
  /** Lets keyboard users reach a hint whose content is not itself a control. */
  focusable?: boolean;
  placement?: "top" | "bottom";
  text?: ReactNode;
}) {
  const tooltipId = useId();
  if (!text) return <>{children}</>;
  return (
    <span
      aria-describedby={focusable ? tooltipId : undefined}
      className={cn("group/hint relative inline-flex", className)}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the focusable wrapper reveals its hint for keyboard users
      tabIndex={focusable ? 0 : undefined}
    >
      {children}
      <span
        className={cn(
          "pointer-events-none invisible absolute left-1/2 z-30 w-max max-w-64 -translate-x-1/2 rounded-md bg-primary px-2 py-1 text-left text-xs font-normal text-primary-foreground opacity-0 transition-opacity delay-200 duration-150 group-focus-within/hint:visible group-focus-within/hint:opacity-100 group-hover/hint:visible group-hover/hint:opacity-100 motion-reduce:transition-none",
          placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
        id={tooltipId}
        role="tooltip"
      >
        {text}
      </span>
    </span>
  );
}

/**
 * A card for explanations that carry a command to copy. It opens on hover or
 * focus, and a tap on its trigger keeps it open, so touch screens reach it.
 */
export function HintCard({
  align = "start",
  children,
  content,
  focusable = false,
}: {
  /** Which edge of the trigger the card lines up with. */
  align?: "start" | "end";
  children: ReactNode;
  content: ReactNode;
  /** Lets keyboard users reach a card whose trigger is not itself a control. */
  focusable?: boolean;
}) {
  const [pinned, setPinned] = useState(false);
  return (
    <span
      className="group/card relative inline-flex"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setPinned(false);
      }}
      onPointerUp={(event) => {
        // Taps inside the card, such as Copy, leave it open.
        if (!(event.target as Element).closest("[data-hint-card]"))
          setPinned((value) => !value);
      }}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the focusable wrapper reveals its card for keyboard users
      tabIndex={focusable ? 0 : undefined}
    >
      {children}
      {/* The transparent top padding bridges the gap so the card stays open while the pointer moves onto it. */}
      <span
        className={cn(
          "invisible absolute top-full z-30 w-80 pt-1.5 opacity-0 transition-opacity delay-150 duration-150 group-focus-within/card:visible group-focus-within/card:opacity-100 group-hover/card:visible group-hover/card:opacity-100 motion-reduce:transition-none",
          align === "end" ? "right-0" : "left-0",
          pinned && "visible opacity-100",
        )}
        data-hint-card
      >
        <span className="block rounded-lg bg-popover px-3 py-2.5 text-left text-xs text-muted-foreground shadow-md">
          {content}
        </span>
      </span>
    </span>
  );
}
