import { useEffect, useRef } from "react";
import type { InstallationJob } from "./api.js";
import { StageProgress } from "./StageProgress.js";

const progressStorageKey = "linger.installer.progress";
function restoredProgress(jobId: string): number {
  try {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem(progressStorageKey) ?? "null",
    );
    if (
      saved &&
      typeof saved === "object" &&
      "jobId" in saved &&
      saved.jobId === jobId &&
      "value" in saved &&
      typeof saved.value === "number" &&
      Number.isFinite(saved.value) &&
      saved.value >= 0 &&
      saved.value <= 100
    )
      return saved.value;
  } catch {
    /* Storage may be unavailable; installation still runs independently. */
  }
  return 0;
}

export function InstallationProgress({
  job,
  now,
}: {
  job: InstallationJob;
  now: number;
}) {
  const current =
    job.stages.find((stage) => stage.state === "failed") ??
    job.stages.find(
      (stage) => stage.id === "runtime" && stage.state === "running",
    ) ??
    job.stages.find(
      (stage) => stage.id === job.stage && stage.state === "running",
    ) ??
    [...job.stages].reverse().find((stage) => stage.state === "running") ??
    job.stages.find((stage) => stage.id === job.stage);
  const labels: Record<string, string> = {
    preflight: "Check environment",
    release: "Prepare installation resources",
    images: "Preparing native source services",
    services: "Start data and services",
    account: "Prepare login account",
    computer: "Connect this computer",
    runtime: "Check runtime tools",
  };
  const finished = job.stages.filter(
    (stage) => stage.state === "succeeded" || stage.state === "skipped",
  ).length;
  const fraction = job.stages.reduce((sum, stage) => {
    if (stage.state === "succeeded" || stage.state === "skipped")
      return sum + 1;
    const counter = stage.progress;
    return (
      sum +
      (stage.state === "running" && counter?.total && counter.total > 0
        ? Math.min(0.95, Math.max(0, counter.completed / counter.total))
        : 0)
    );
  }, 0);
  // Milestones and real byte/item counters only. Time never advances this bar.
  // Multiple files can reset a counter; keep the visual position within this job.
  const value =
    job.state === "succeeded"
      ? 100
      : job.stages.length
        ? Math.min(99, (fraction / job.stages.length) * 100)
        : 0;
  const recovered = Math.max(value, restoredProgress(job.id));
  const position = useRef({ id: job.id, value: recovered });
  if (position.current.id !== job.id)
    position.current = { id: job.id, value: recovered };
  else position.current.value = Math.max(position.current.value, value);
  const displayValue = position.current.value;
  useEffect(() => {
    if (displayValue <= 0) return;
    try {
      sessionStorage.setItem(
        progressStorageKey,
        JSON.stringify({ jobId: job.id, value: displayValue }),
      );
    } catch {
      /* Progress remains live when browser storage is disabled. */
    }
  }, [job.id, displayValue]);
  const running = ["running", "queued"].includes(job.state);
  const title = job.cancelRequested
    ? "Stopping after the current step"
    : job.state === "waiting_user"
      ? job.runtimeAuth && job.origin
        ? "Business services are ready"
        : job.runtimeAuth
          ? "Sign in to continue"
          : "Waiting for your confirmation"
      : ["failed", "interrupted", "canceled"].includes(job.state)
        ? "Installation paused"
        : current?.message ||
          labels[current?.id ?? job.stage ?? ""] ||
          job.message ||
          "Preparing installation job";
  return (
    <section
      className="installation-progress"
      aria-label={"Installation status"}
    >
      <h2 aria-live="polite">{title}</h2>
      <div
        className={`installation-track ${running ? "is-active" : ""}`}
        role="progressbar"
        aria-label={"Installation progress"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(displayValue)}
        aria-valuetext={`${finished} of ${job.stages.length} stages complete`}
      >
        <span
          className="installation-fill"
          style={{ width: `${displayValue}%` }}
        />
        {running && (
          <span className="installation-activity" aria-hidden="true" />
        )}
      </div>
      {running && current?.progress && (
        <StageProgress
          key={`${job.id}:${current.id}`}
          progress={current.progress}
          now={now}
        />
      )}
    </section>
  );
}
