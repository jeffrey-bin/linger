import type { RuntimeStatusUpdate } from "../../executor/runtime-status.js";
import type { RunEvent } from "../../executor/provider.js";

export const projectRunEventToRuntimeStatus = (
  event: RunEvent,
): RuntimeStatusUpdate | null => {
  if (event.type === "status.changed") {
    return {
      type: "status.changed",
      status: event.status,
      ...(event.title === undefined ? {} : { title: event.title }),
    };
  }
  if (event.type === "plan.updated") {
    return {
      type: "plan.updated",
      ...(event.explanation === undefined
        ? {}
        : { explanation: event.explanation }),
      steps: event.steps.map((step) => ({ ...step })),
    };
  }
  if (
    event.type === "activity.started" ||
    event.type === "activity.updated" ||
    event.type === "activity.finished"
  ) {
    return { ...event };
  }
  return null;
};
