import { describe, expect, it } from "vitest";

import { selectMountedTaskTabs } from "./task-keep-alive";

describe("selectMountedTaskTabs", () => {
  it("keeps active plus two most recently activated", () => {
    const mounted = selectMountedTaskTabs({
      openTabIds: ["a", "b", "c", "d", "e"],
      activeTabId: "c",
      lastActivatedAt: { a: 1, b: 5, c: 10, d: 8, e: 2 },
      windowSize: 3,
    });
    expect(mounted).toEqual(["c", "d", "b"]);
  });

  it("never exceeds window size", () => {
    const mounted = selectMountedTaskTabs({
      openTabIds: ["a", "b"],
      activeTabId: "a",
      lastActivatedAt: { a: 2, b: 1 },
      windowSize: 3,
    });
    expect(mounted).toEqual(["a", "b"]);
  });
});
