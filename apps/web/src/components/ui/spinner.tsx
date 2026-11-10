import type { ComponentPropsWithoutRef } from "react";

const SPINNER_BARS = Array.from({ length: 12 }, (_, index) => index);

/**
 * Inline busy indicator, the motion counterpart to {@link Skeleton}: Town's
 * twelve-bar spinner. Decorative by default (it sits beside its own label); it
 * inherits the surrounding color and honors reduced-motion.
 */
export function Spinner({
  className = "",
  size = 16,
  style,
  ...props
}: Omit<ComponentPropsWithoutRef<"span">, "children"> & {
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      className={`town-spinner shrink-0 text-current ${className}`}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      {SPINNER_BARS.map((bar) => (
        <span
          key={bar}
          style={{
            transform: `rotate(${bar * 30}deg)`,
            animationDelay: `${(bar - 12) / 10}s`,
          }}
        />
      ))}
    </span>
  );
}
