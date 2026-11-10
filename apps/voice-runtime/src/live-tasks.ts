import type { VoiceLiveAlert, VoiceLiveTask } from "./live-client.js";

export interface TaskUpdate {
  taskId: string;
  goal: string;
  /**
   * report is a task's report to the live voice as its coordinator (a
   * result, or what it needs from the user); failed ends the work; approval
   * waits for a card in the chat.
   */
  kind: "report" | "failed" | "approval" | "alert" | "browser";
  /** What to tell, full text: the reports or the failure. */
  replies: string[];
  /** Times it was told without the provider starting it. */
  attempts?: number;
}

interface Tracked {
  state: VoiceLiveTask["state"];
  seen: Set<string>;
}

/**
 * Turns successive task lists into what to say. The live voice coordinates
 * each task as a Meta does: every new report is returned once as a note, so
 * the live model can answer follow-ups from it, and told at once, for the
 * live model to judge whether it is a result or a question for the user.
 * Tasks from earlier calls are notes only, unless they wait for an approval.
 */
export class TaskTracker {
  private readonly tasks = new Map<string, Tracked>();
  private readonly alerts = new Set<string>();

  /** Whether any task may still produce something to say. */
  get active() {
    for (const task of this.tasks.values())
      if (
        task.state === "pending" ||
        task.state === "working" ||
        task.state === "waiting_for_approval"
      )
        return true;
    return false;
  }

  /** A task was just started or answered in this call. */
  started(taskId: string) {
    const task = this.tasks.get(taskId);
    if (task) task.state = "pending";
    else this.tasks.set(taskId, { state: "pending", seen: new Set() });
  }

  /**
   * New notes (every unseen report) and updates to say, in task order. An
   * event from the user's apps worth telling now is said once.
   */
  apply(
    list: VoiceLiveTask[],
    alerts: VoiceLiveAlert[] = [],
  ): { notes: TaskUpdate[]; updates: TaskUpdate[] } {
    const notes: TaskUpdate[] = [];
    const updates: TaskUpdate[] = [];
    for (const alert of alerts) {
      if (this.alerts.has(alert.alert_id)) continue;
      this.alerts.add(alert.alert_id);
      const update: TaskUpdate = {
        taskId: alert.alert_id,
        goal: "",
        kind: "alert",
        replies: [alert.text],
      };
      notes.push(update);
      updates.push(update);
    }
    for (const task of list) {
      let tracked = this.tasks.get(task.task_id);
      // Work from before this call is known, not news. A restarted worker
      // still tells this call's own reports.
      const earlier =
        !tracked &&
        !task.started_in_this_call &&
        !task.replies.some((reply) => reply.delivered === false);
      if (!tracked) {
        tracked = { state: task.state, seen: new Set() };
        this.tasks.set(task.task_id, tracked);
      }
      const base = { taskId: task.task_id, goal: task.goal };
      const fresh = task.replies.filter(
        (reply) => !tracked.seen.has(reply.message_id),
      );
      for (const reply of fresh) tracked.seen.add(reply.message_id);
      const replies = fresh.map((reply) => reply.text);
      if (replies.length) notes.push({ ...base, kind: "report", replies });
      const was = tracked.state;
      tracked.state = task.state;
      if (task.state === "waiting_for_approval") {
        if (earlier || was !== "waiting_for_approval")
          updates.push({ ...base, kind: "approval", replies: [] });
        continue;
      }
      if (earlier) continue;
      if (
        task.state === "reported" &&
        fresh.some((reply) => reply.delivered !== true)
      )
        updates.push({ ...base, kind: "report", replies });
      else if (task.state === "failed" && was !== "failed") {
        const latest = task.replies.at(-1)?.text;
        updates.push({
          ...base,
          kind: "failed",
          replies: latest ? [latest] : [],
        });
      }
    }
    return { notes, updates };
  }
}
