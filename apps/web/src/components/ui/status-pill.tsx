import type { ReactNode } from "react";

type StatusPillTone = "neutral" | "warning" | "success" | "danger";

export function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: StatusPillTone;
}) {
  return <span className={`town-badge town-badge-${tone}`}>{children}</span>;
}
