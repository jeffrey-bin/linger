import { RefreshIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

export function PreviewSessionExpiryNotice({
  expiresAt,
  onRefresh,
}: {
  expiresAt?: string;
  onRefresh: () => void;
}) {
  const [expiredAt, setExpiredAt] = useState<string>();

  useEffect(() => {
    if (!expiresAt) return;
    const deadline = Date.parse(expiresAt);
    if (!Number.isFinite(deadline)) return;
    const timer = window.setTimeout(
      () => setExpiredAt(expiresAt),
      Math.max(0, deadline - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  if (!expiresAt || expiredAt !== expiresAt) return null;
  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-app-border bg-app-surface px-3 py-2"
      role="status"
    >
      <p className="text-sm text-app-muted">
        Preview expired. Refresh to load linked resources.
      </p>
      <Button onClick={onRefresh} size="compact" tone="secondary">
        <Icon icon={RefreshIcon} size={14} /> Refresh preview
      </Button>
    </div>
  );
}
