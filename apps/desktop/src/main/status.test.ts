import { describe, expect, it } from "vitest";

import { summarizeStatus } from "./status.js";

const base = {
  connection: "online",
  runtime: "ready" as const,
  enrolled: true,
  running: 0,
};

describe("summarizeStatus", () => {
  it("describes each state in one line", () => {
    expect(summarizeStatus(base)).toEqual({
      tone: "online",
      label: "Online · Idle",
    });
    expect(summarizeStatus({ ...base, running: 2 })).toEqual({
      tone: "busy",
      label: "Running 2 Tasks",
    });
    expect(summarizeStatus({ ...base, connection: "connecting" })).toEqual({
      tone: "offline",
      label: "Offline · Reconnecting",
    });
    expect(summarizeStatus({ ...base, connection: "auth_failed" }).tone).toBe(
      "error",
    );
    expect(summarizeStatus({ ...base, runtime: "crashed" }).tone).toBe("error");
    expect(summarizeStatus({ ...base, runtime: "starting" }).label).toBe(
      "Starting…",
    );
    expect(summarizeStatus({ ...base, enrolled: false }).tone).toBe("setup");
  });

  it("asks to reconnect when the daemon has no valid credential", () => {
    expect(
      summarizeStatus({
        ...base,
        connection: "auth_failed",
        runtime: "stopped",
      }),
    ).toEqual({
      tone: "error",
      label: "Sign-in Expired · Reconnect This Computer",
    });
  });
});
