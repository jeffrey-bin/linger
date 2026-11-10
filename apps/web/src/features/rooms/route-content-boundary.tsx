import { Suspense, type ReactNode } from "react";
import { useLocation, useNavigation } from "react-router";

import { Skeleton } from "@/components/ui/skeleton";
import { routeLayoutKey } from "./route-layout-key";

const CONTENT_LOADING = (
  <div
    role="status"
    aria-label="Loading content"
    aria-busy="true"
    className="route-loading-surface min-w-0 flex-1 space-y-4 p-6"
  >
    <span className="sr-only">Loading content...</span>
    <Skeleton className="h-6 w-40" />
    <Skeleton className="h-24 w-full" />
  </div>
);

/** Secondary navigation survives both route-module and query loading. */
export function RouteContentBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigation = useNavigation();
  const next = navigation.location?.pathname;
  const changingContent =
    navigation.state !== "idle" &&
    next !== undefined &&
    next !== location.pathname &&
    routeLayoutKey(next) === routeLayoutKey(location.pathname);
  return changingContent ? (
    CONTENT_LOADING
  ) : (
    <Suspense key={location.pathname} fallback={CONTENT_LOADING}>
      {children}
    </Suspense>
  );
}
