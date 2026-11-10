import { expect, it } from "vitest";
import { isUpgradeRecommended } from "./computer-version";

it.each([
  [undefined, true],
  ["0.1.0", true],
  ["0.2.0-rc.1", true],
  ["0.2.0", false],
  ["0.2.0+release.12", false],
  ["0.10.0", false],
  ["dev", false],
] as const)(
  "compares reported release %s without rejecting usable clients",
  (version, expected) => {
    expect(
      isUpgradeRecommended({
        daemon_version: version,
        recommended_version: "0.2.0",
      }),
    ).toBe(expected);
    expect(isUpgradeRecommended({ daemon_version: version })).toBe(false);
  },
);
