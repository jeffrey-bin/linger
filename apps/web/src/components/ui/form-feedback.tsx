import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";

import { Icon, type IconSvgElement } from "@/components/ui/icon";

type FormFeedbackTone = "danger" | "info" | "success";

const feedbackStyle: Record<
  FormFeedbackTone,
  { className: string; icon: IconSvgElement; role: "alert" | "status" }
> = {
  danger: {
    className:
      "border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] text-[var(--app-status-danger-text)]",
    icon: AlertCircleIcon,
    role: "alert",
  },
  info: {
    className:
      "border-[var(--app-card-info-border)] bg-[var(--app-card-info-surface)] text-[var(--app-card-info-text)]",
    icon: InformationCircleIcon,
    role: "status",
  },
  success: {
    className:
      "border-[var(--app-status-success-border)] bg-[var(--app-status-success-surface)] text-[var(--app-status-success-text)]",
    icon: CheckmarkCircle02Icon,
    role: "status",
  },
};

export function FormFeedback({
  children,
  tone,
}: {
  children: ReactNode;
  tone: FormFeedbackTone;
}) {
  const style = feedbackStyle[tone];

  return (
    <p
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${style.className}`}
      role={style.role}
    >
      <Icon className="mt-[3px] shrink-0" icon={style.icon} size={14} />
      <span>{children}</span>
    </p>
  );
}
