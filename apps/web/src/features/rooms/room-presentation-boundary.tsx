import { useEffect, useState, type ReactNode } from "react";

interface Snapshot {
  initialRoomSeq: number;
}
type Result = { source: Promise<Snapshot> } & (
  | { value: Snapshot }
  | { error: unknown }
);

/** Paint the ready projection without Suspense's fallback reveal delay. */
export function RoomPresentationBoundary({
  presentation,
  fallback,
  children,
}: {
  presentation: Promise<Snapshot>;
  fallback: ReactNode;
  children: (snapshot: Snapshot) => ReactNode;
}) {
  const [result, setResult] = useState<Result>();
  useEffect(() => {
    let cancelled = false;
    void presentation.then(
      (value) => {
        if (!cancelled) setResult({ source: presentation, value });
      },
      (error: unknown) => {
        if (!cancelled) setResult({ source: presentation, error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [presentation]);

  if (result?.source !== presentation) return fallback;
  if ("error" in result) throw result.error;
  return children(result.value);
}
