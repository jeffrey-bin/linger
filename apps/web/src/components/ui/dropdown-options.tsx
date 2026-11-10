import type { ComponentProps, ReactNode } from "react";

/**
 * The floating option list every Select opens, after Figma 8713:10526, drawn
 * as the Town dropdown: a 6px popover card whose 33px rows highlight in accent.
 * Positioning, roles, and keyboard handling stay with the caller.
 */
export function DropdownOptions({
  children,
  className = "",
  listClassName = "",
  ref,
  ...props
}: ComponentProps<"div"> & { listClassName?: string }) {
  return (
    <div {...props} className={`dropdown-options ${className}`} ref={ref}>
      <div
        className={`dropdown-options-list workspace-scrollbar ${listClassName}`}
      >
        {children}
      </div>
    </div>
  );
}

export function DropdownOption({
  children,
  className = "",
  ...props
}: Omit<ComponentProps<"button">, "children"> & { children: ReactNode }) {
  return (
    <button type="button" {...props} className={`dropdown-option ${className}`}>
      <span className="dropdown-option-label truncate">{children}</span>
    </button>
  );
}
