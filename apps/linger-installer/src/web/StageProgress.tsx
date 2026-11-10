import { useRef } from "react";
import type { components } from "@linger/wire-contracts/linger-installer/types";
import { bytes } from "./SetupChoicePanel.js";
type Counter = components["schemas"]["ProgressCounter"];
export function StageProgress({
  progress,
  now,
}: {
  progress: Counter;
  now: number;
}) {
  const initial = useRef({ completed: progress.completed, at: now });
  const previous = useRef({
    completed: progress.completed,
    total: progress.total,
  });
  if (
    progress.completed < previous.current.completed ||
    progress.total !== previous.current.total
  )
    initial.current = { completed: progress.completed, at: now };
  previous.current = { completed: progress.completed, total: progress.total };
  const elapsed = Math.max(0, (now - initial.current.at) / 1000);
  const speed =
    elapsed > 0
      ? (progress.completed - initial.current.completed) / elapsed
      : 0;
  const format = (value: number) =>
    progress.unit === "bytes"
      ? bytes(value)
      : `${value.toLocaleString("en")} ${progress.unit}`;
  return (
    <p className="progress-counter">
      {format(progress.completed)}
      {progress.total == null ? "" : ` / ${format(progress.total)}`} ·{" "}
      {Math.floor(elapsed)} {"sec"}
      {progress.unit === "bytes" && speed > 0
        ? ` · ${(speed / 1024 ** 2).toFixed(1)} MiB/s`
        : ""}
      {progress.total != null && speed > 0
        ? ` · about ${Math.ceil(Math.max(0, progress.total - progress.completed) / speed / 60)} min left`
        : ""}
    </p>
  );
}
