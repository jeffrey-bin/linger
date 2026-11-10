import type { ComponentPropsWithoutRef } from "react";

export function Skeleton({
  className = "",
  ...props
}: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      aria-hidden="true"
      className={`town-skeleton block rounded-lg bg-muted ${className}`}
      {...props}
    />
  );
}
