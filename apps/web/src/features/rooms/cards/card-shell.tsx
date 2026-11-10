import type { ReactNode } from "react";

import { Icon, type IconSvgElement } from "@/components/ui/icon";

export type ReceiptTone = "danger" | "muted" | "success" | "warning";

const toneClass: Record<ReceiptTone, string> = {
  danger: "text-app-danger",
  muted: "text-app-muted",
  success: "text-app-success",
  warning: "text-app-warning",
};

/**
 * Minimal chat cards: the Agent's words carry the guidance and the card is
 * only the thing to act on. `CardPrompt` shows the card's text as one more
 * bubble from the Agent; `CardBox` holds just the interaction; `CardDone`
 * takes the place of the buttons once the person has acted.
 */
export function CardPrompt({ children }: { children: ReactNode }) {
  return (
    <p className="card-prompt mt-1 [overflow-wrap:anywhere]">{children}</p>
  );
}

/**
 * A system-issued card's fixed title heads the box as a quiet label instead
 * of reading as the Agent's words; only text an Agent wrote goes in a
 * `CardPrompt` bubble.
 */
export function CardBox({
  children,
  heading,
  label,
}: {
  children: ReactNode;
  heading?: string;
  label: string;
}) {
  return (
    <section aria-label={label} className="card-box mt-1.5">
      {heading ? <CardHeading>{heading}</CardHeading> : null}
      {children}
    </section>
  );
}

/** A card's bold heading, for a card that lays its heading out itself. */
export function CardHeading({ children }: { children: string }) {
  return (
    <header className="pb-2">
      <h3 className="[overflow-wrap:anywhere] text-sm font-semibold text-app-ink">
        {children}
      </h3>
    </header>
  );
}

export function CardDone({
  icon,
  text,
  tone,
}: {
  icon: IconSvgElement;
  text: string;
  tone: ReceiptTone;
}) {
  return (
    <p className="flex items-center gap-1.5 pt-1 pb-1.5 text-xs text-app-muted">
      <Icon className={`shrink-0 ${toneClass[tone]}`} icon={icon} size={14} />
      <span className={tone === "success" ? "text-app-success" : undefined}>
        {text}
      </span>
    </p>
  );
}
