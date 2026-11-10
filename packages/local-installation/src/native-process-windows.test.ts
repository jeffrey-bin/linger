import { describe, expect, it } from "vitest";
import { windowsLeaseTree } from "./native-process-identity.js";

const lease = "a".repeat(64);
const row = (pid: number, parent: number, created: number, command = "") => ({
  pid,
  parent,
  created,
  command,
});

describe("windowsLeaseTree", () => {
  it("starts at the supervisor whose job carries the lease", () => {
    const tree = windowsLeaseTree(
      [
        row(10, 1, 100, `node worker.mjs C:\\x\\postgres.${lease}.job`),
        row(11, 10, 101, "postgres.exe"),
        row(12, 11, 102, "postgres.exe"),
        row(13, 1, 103, "unrelated.exe"),
      ],
      lease,
    );
    expect(tree.map((candidate) => candidate.pid)).toEqual([10, 11, 12]);
  });

  it("rejects a reused PID that is older than its claimed parent", () => {
    const tree = windowsLeaseTree(
      [
        row(10, 1, 100, `worker postgres.${lease}.job`),
        row(11, 10, 50, "stale.exe"),
      ],
      lease,
    );
    expect(tree.map((candidate) => candidate.pid)).toEqual([10]);
  });

  it("finds nothing without the lease", () => {
    expect(
      windowsLeaseTree(
        [row(10, 1, 100, `worker postgres.${"b".repeat(64)}.job`)],
        lease,
      ),
    ).toEqual([]);
  });
});
