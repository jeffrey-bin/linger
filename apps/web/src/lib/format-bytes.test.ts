import { describe, expect, it } from "vitest";

import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  it("picks the largest unit that keeps the value at or above one", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5_132_902)).toBe("4.9 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3 GB");
  });
});
