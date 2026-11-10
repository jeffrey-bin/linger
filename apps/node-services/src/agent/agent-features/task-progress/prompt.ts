import type { TaskProgressSnapshot, TaskProgressTask } from "./client.js";

/** A short duration such as 45s, 12m or 2h5m. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function taskLine(task: TaskProgressTask, now: number): string {
  const ago = (at: string) => formatDuration(now - Date.parse(at));
  const parts = [
    task.status === "running"
      ? `running for ${ago(task.status_since)}`
      : `waiting for approval for ${ago(task.status_since)}`,
    task.last_report_at
      ? `last report ${ago(task.last_report_at)} ago`
      : "no report yet",
  ];
  if (task.pending_approvals > 0)
    parts.push(
      `${task.pending_approvals} approval${task.pending_approvals === 1 ? "" : "s"} pending`,
    );
  if (task.latest_step)
    parts.push(
      `latest step "${task.latest_step.title}" (${ago(task.latest_step.at)} ago)`,
    );
  return `- ${task.task_id} "${task.title}": ${parts.join("; ")}`;
}

/**
 * The trusted follow-up that asks a Meta to consider telling the user how
 * its Tasks go. It carries just enough for the Meta to judge; the Meta reads
 * details with task check before it says anything.
 */
export function renderTaskProgressReminder(
  snapshot: TaskProgressSnapshot,
  now: number,
): string {
  const silence = snapshot.agent_last_spoke_at
    ? `nobody in this Room has heard from you for ${formatDuration(now - Date.parse(snapshot.agent_last_spoke_at))}`
    : "you have not said anything in this Room yet";
  return [
    `[Task progress check] Tasks you coordinate are still at work, and ${silence}. As of now:`,
    ...snapshot.tasks.map((task) => taskLine(task, now)),
    "If something here is worth telling the user, run teamhub task check --task-id <id> first, then tell them in one short message with teamhub message send, as your own update; do not mention this check. If nothing that matters changed, do nothing.",
  ].join("\n");
}
