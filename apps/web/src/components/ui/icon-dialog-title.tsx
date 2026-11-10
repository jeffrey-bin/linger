import type { ReactNode } from "react";

import { Icon, type IconSvgElement } from "@/components/ui/icon";

/** A dialog title led by a small icon tile, for dialogs that ask for a key. */
export function IconDialogTitle({
  children,
  icon,
}: {
  children: ReactNode;
  icon: IconSvgElement;
}) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-card text-foreground shadow-outline">
        <Icon icon={icon} size={16} />
      </span>
      {children}
    </span>
  );
}
