import { Icon, type IconSvgElement } from "@/components/ui/icon";

export function PanelCollectionChrome({
  icon,
  subtitle,
  title,
}: {
  icon: IconSvgElement;
  subtitle?: string;
  title: string;
}) {
  return (
    <header className="shrink-0 border-b border-app-border bg-app-surface px-3 py-2.5">
      <p className="flex items-center gap-2 text-sm font-semibold text-app-ink">
        <Icon className="text-app-muted" icon={icon} size={14} />
        {title}
      </p>
      {subtitle ? (
        <p className="mt-0.5 pl-[22px] text-xs leading-4 text-app-muted">
          {subtitle}
        </p>
      ) : null}
    </header>
  );
}
