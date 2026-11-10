import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export type { IconSvgElement };

/** Town iconography: stroke 2 up to 16px, 1.5 from 20px so optical weight holds. */
export function Icon({
  className,
  icon,
  size = 16,
}: {
  className?: string;
  icon: IconSvgElement;
  size?: number;
}) {
  return (
    <HugeiconsIcon
      aria-hidden="true"
      className={className}
      icon={icon}
      size={size}
      strokeWidth={size >= 20 ? 1.5 : 2}
    />
  );
}
