import { describe, expect, it } from "vitest";

import { TaskTracker } from "./live-tasks.js";

type State =
  | "pending"
  | "working"
  | "waiting_for_approval"
  | "reported"
  | "failed"
  | "canceled";

const task = (state: State, replies: string[] = [], started = true) => ({
  task_id: "t1",
  started_in_this_call: started,
  goal: "Compare prices",
  surface: "web" as const,
  state,
  replies: replies.map((text, index) => ({ message_id: `r${index}`, text })),
});

describe("TaskTracker", () => {
  it("tells each new report once, as soon as the task reports", () => {
    const tracker = new TaskTracker();
    tracker.started("t1");
    expect(tracker.active).toBe(true);
    expect(tracker.apply([task("working")]).updates).toEqual([]);
    const reported = tracker.apply([
      task("reported", ["Sony at 1899 is the best fit"]),
    ]);
    expect(reported.notes.map((note) => note.replies)).toEqual([
      ["Sony at 1899 is the best fit"],
    ]);
    expect(reported.updates).toMatchObject([
      {
        taskId: "t1",
        kind: "report",
        replies: ["Sony at 1899 is the best fit"],
      },
    ]);
    expect(tracker.active).toBe(false);
    expect(
      tracker.apply([task("reported", ["Sony at 1899 is the best fit"])])
        .updates,
    ).toEqual([]);
  });

  it("tells a report that asks the user, and the next one after the answer", () => {
    const tracker = new TaskTracker();
    tracker.started("t1");
    expect(
      tracker.apply([
        task("reported", ["JD needs a new login: scan the QR code"]),
      ]).updates,
    ).toMatchObject([
      { kind: "report", replies: ["JD needs a new login: scan the QR code"] },
    ]);
    tracker.started("t1");
    expect(
      tracker.apply([
        task("working", ["JD needs a new login: scan the QR code"]),
      ]).updates,
    ).toEqual([]);
    expect(
      tracker.apply([
        task("reported", [
          "JD needs a new login: scan the QR code",
          "Order placed",
        ]),
      ]).updates,
    ).toMatchObject([{ kind: "report", replies: ["Order placed"] }]);
  });

  it("tells an approval wait once and a failure with its reason", () => {
    const tracker = new TaskTracker();
    tracker.started("t1");
    expect(tracker.apply([task("waiting_for_approval")]).updates).toMatchObject(
      [{ kind: "approval" }],
    );
    expect(tracker.apply([task("waiting_for_approval")]).updates).toEqual([]);
    expect(
      tracker.apply([task("failed", ["File not found"])]).updates,
    ).toMatchObject([{ kind: "failed", replies: ["File not found"] }]);
  });

  it("keeps reports from earlier calls as context and tells only approval waits", () => {
    const tracker = new TaskTracker();
    const earlier = tracker.apply([
      task("reported", ["The report is written"], false),
      { ...task("waiting_for_approval", [], false), task_id: "t2" },
    ]);
    expect(earlier.notes.map((note) => note.taskId)).toEqual(["t1"]);
    expect(earlier.updates).toMatchObject([{ taskId: "t2", kind: "approval" }]);
    const later = tracker.apply([
      task("reported", ["The report is written", "Added one more page"], false),
      { ...task("reported", ["The weekly report is sent"]), task_id: "t3" },
    ]);
    expect(later.updates.map((update) => update.taskId)).toEqual(["t1", "t3"]);
  });

  it("still tells this call's report after the worker restarts", () => {
    const restarted = new TaskTracker();
    expect(
      restarted.apply([task("reported", ["Sony at 1899 is the best fit"])])
        .updates,
    ).toMatchObject([{ taskId: "t1", kind: "report" }]);
  });

  it("tells an urgent app event once", () => {
    const tracker = new TaskTracker();
    const alert = { alert_id: "a1", text: "Lisa asks about the quote" };
    expect(tracker.apply([], [alert]).updates).toMatchObject([
      { kind: "alert", replies: ["Lisa asks about the quote"] },
    ]);
    expect(tracker.apply([], [alert]).updates).toEqual([]);
  });
});
