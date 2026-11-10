import { Download04Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";

import { Button } from "@/components/ui/button";

export function PreviewAdapterError({
  message,
  onDownload,
}: {
  message: string;
  onDownload: () => void;
}) {
  return (
    <div
      className="flex h-full min-h-[420px] flex-col items-center justify-center gap-3 bg-app-surface-soft p-8 text-center"
      role="alert"
    >
      <p className="max-w-lg text-sm text-app-danger">{message}</p>
      <Button onClick={onDownload} tone="secondary">
        <Icon icon={Download04Icon} />
        Download original
      </Button>
    </div>
  );
}
