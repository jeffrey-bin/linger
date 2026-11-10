import { Spinner } from "@/components/ui/spinner";
import { lazy, Suspense } from "react";

import type { MediaPreviewAdapterProps } from "./media-preview-adapter";

const LazyMediaPreviewAdapter = lazy(async () => {
  const module = await import("./media-preview-adapter");
  return { default: module.MediaPreviewAdapter };
});

export function MediaPreviewAdapterLoader(props: MediaPreviewAdapterProps) {
  return (
    <Suspense
      fallback={
        <div
          className="flex h-full min-h-[420px] items-center justify-center gap-2 text-sm text-app-subtle"
          role="status"
        >
          <Spinner size={16} />
          Loading media player...
        </div>
      }
    >
      <LazyMediaPreviewAdapter {...props} />
    </Suspense>
  );
}
