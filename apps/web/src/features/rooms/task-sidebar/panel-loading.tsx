import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

/**
 * The one loading state for sidebar panels: quiet skeleton lines in place of
 * the content, with the label kept for assistive technology only.
 */
export function PanelLoading({
  className = "",
  label,
}: {
  className?: string;
  label: string;
}) {
  return (
    <div
      aria-busy="true"
      className={cn("space-y-3 px-4 py-5", className)}
      role="status"
    >
      <span className="sr-only">{label}</span>
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-3 w-3/5" />
    </div>
  );
}
