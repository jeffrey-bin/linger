import { Spinner } from "@/components/ui/spinner";
import { lazy, Suspense } from "react";

import type { DataPreviewAdapterProps } from "./data-preview-adapter";

const DataPreviewAdapter = lazy(async () => {
  const module = await import("./data-preview-adapter");
  return { default: module.DataPreviewAdapter };
});

export function DataPreviewAdapterLoader(props: DataPreviewAdapterProps) {
  return (
    <Suspense
      fallback={
        <div
          className="flex h-full min-h-[420px] items-center justify-center gap-2 text-sm text-app-subtle"
          role="status"
        >
          <Spinner size={16} />
          Loading data preview...
        </div>
      }
    >
      <DataPreviewAdapter {...props} />
    </Suspense>
  );
}
