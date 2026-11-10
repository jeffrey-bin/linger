import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * A labelled white group of rows on a tinted canvas, in the style of system
 * settings. Rows separate with hairlines that start after their icon.
 */
export function SettingsGroup({
  action,
  ariaLabel,
  children,
  footer,
  label,
  meta,
}: {
  /** Small commands at the right of the label, such as Add or Edit. */
  action?: ReactNode;
  ariaLabel?: string;
  children: ReactNode;
  /** Short note under the group. */
  footer?: ReactNode;
  label?: string;
  /** Quiet text after the label, such as a count. */
  meta?: ReactNode;
}) {
  return (
    <section aria-label={ariaLabel ?? label} className="px-1.5">
      {label ? (
        <div className="flex min-h-7 items-center gap-1.5 px-1.5 pb-1">
          <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
          {meta ? (
            <span className="text-xs tabular-nums text-muted-foreground/80">
              {meta}
            </span>
          ) : null}
          {action ? (
            <span className="ml-auto flex items-center gap-0.5">{action}</span>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-xl bg-card shadow-outline">
        {/* Pulls the first row's top hairline under the rounded edge. */}
        <div className="-mt-px">{children}</div>
      </div>
      {footer ? (
        <div className="px-1.5 pt-1.5 text-xs leading-[18px] text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

/** One row of a SettingsGroup: an optional icon, then content with a hairline above. */
export function SettingsRow({
  children,
  className,
  icon,
}: {
  children: ReactNode;
  className?: string;
  /** Pass `null` to keep the icon column empty so text lines up with rows that have one. */
  icon?: ReactNode;
}) {
  return (
    <div className={cn("flex items-stretch gap-2.5 pl-3.5", className)}>
      {icon !== undefined ? (
        <span
          aria-hidden="true"
          className="flex w-5 shrink-0 items-center justify-center text-muted-foreground"
        >
          {icon}
        </span>
      ) : null}
      <div className="flex min-h-11 min-w-0 flex-1 items-center gap-3 border-t border-border py-2 pr-3.5">
        {children}
      </div>
    </div>
  );
}

/** Title and an optional second line inside a SettingsRow. */
export function SettingsRowText({
  description,
  muted = false,
  title,
  titleClassName,
}: {
  description?: ReactNode;
  muted?: boolean;
  title: ReactNode;
  titleClassName?: string;
}) {
  return (
    <span className="min-w-0 flex-1">
      <span
        className={cn(
          "block truncate text-[14px] font-medium leading-[18px]",
          muted ? "text-muted-foreground" : "text-foreground",
          titleClassName,
        )}
      >
        {title}
      </span>
      {description ? (
        <span className="mt-px block truncate text-xs leading-[17px] text-muted-foreground">
          {description}
        </span>
      ) : null}
    </span>
  );
}

/** A quiet text command beside a SettingsGroup label. */
export function SettingsGroupAction({
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
      type={type}
      {...props}
    />
  );
}
