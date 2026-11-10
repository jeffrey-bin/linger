import { useEffect, useState } from "react";

/**
 * Elapsed recording time. Paused time is left out: `pausedMs` is the total of
 * earlier pauses and `pausedAt` freezes the clock while a pause runs.
 */
export function VoiceRecordingTime({
  pausedAt,
  pausedMs = 0,
  startedAt,
}: {
  pausedAt?: number;
  pausedMs?: number;
  startedAt?: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!startedAt || pausedAt !== undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pausedAt, startedAt]);
  if (!startedAt) return null;
  const seconds = Math.max(
    0,
    Math.floor(((pausedAt ?? now) - Date.parse(startedAt) - pausedMs) / 1_000),
  );
  return (
    <span className="tabular-nums">
      {Math.floor(seconds / 60)
        .toString()
        .padStart(2, "0")}
      :{(seconds % 60).toString().padStart(2, "0")}
    </span>
  );
}
