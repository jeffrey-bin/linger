import type { ButtonHTMLAttributes } from "react";

import { Spinner } from "./spinner";

type ButtonSize = "compact" | "compactIcon" | "default" | "icon" | "large";
type ButtonTone =
  | "danger"
  | "ghost"
  | "info"
  | "primary"
  | "secondary"
  | "subtle";

const sizeClassName: Record<ButtonSize, string> = {
  compact: "ui-button-compact gap-1.5 px-2.5 text-xs",
  compactIcon: "ui-button-icon-compact",
  default: "ui-button-default gap-2 px-3 text-xs",
  icon: "ui-button-icon",
  large: "ui-button-large gap-2 px-4 text-sm",
};

const spinnerSize: Record<ButtonSize, number> = {
  compact: 14,
  compactIcon: 14,
  default: 14,
  icon: 16,
  large: 16,
};

const toneClassName: Record<ButtonTone, string> = {
  danger:
    "border border-destructive/40 bg-transparent text-destructive hover:border-foreground/15",
  ghost:
    "border border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
  info: "bg-app-info text-white hover:bg-app-info-hover",
  primary:
    "bg-primary text-primary-foreground shadow-button hover:bg-primary/90",
  secondary:
    "border border-border bg-transparent text-foreground hover:border-foreground/15 hover:bg-accent",
  // Town Secondary pill: soft fill, dark text, primary/9 on hover.
  subtle: "bg-secondary text-secondary-foreground hover:bg-primary/[0.09]",
};

export function Button({
  children,
  className = "",
  disabled = false,
  loading = false,
  size = "default",
  tone = "secondary",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Shows a spinner, keeps the label, and blocks further clicks. */
  loading?: boolean;
  size?: ButtonSize;
  tone?: ButtonTone;
}) {
  return (
    <button
      aria-busy={loading || undefined}
      className={`relative inline-flex shrink-0 items-center justify-center font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 active:scale-(--chat-press-scale) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 ${sizeClassName[size]} ${toneClassName[tone]} ${className}`}
      disabled={disabled || loading}
      type={type}
      {...props}
    >
      {loading ? <Spinner size={spinnerSize[size]} /> : null}
      {children}
    </button>
  );
}
