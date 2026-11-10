import { describe, expect, it } from "vitest";
import { windowsCommandLine } from "./replace-process.mjs";

describe("windowsCommandLine", () => {
  it("quotes paths with spaces and leaves plain arguments alone", () => {
    expect(
      windowsCommandLine("C:\\Program Files\\nodejs\\node.exe", [
        "C:\\Users\\Ada Lovelace\\linger\\scripts\\source-native.mjs",
        "--include",
        "apps/node-services/src/**/*",
        "-p=2",
      ]),
    ).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ada Lovelace\\linger\\scripts\\source-native.mjs" --include "apps/node-services/src/**/*" -p=2',
    );
  });
  it("refuses characters cmd.exe would reinterpret", () => {
    for (const value of ['a"b', "%PATH%", "a\nb"])
      expect(() => windowsCommandLine("pnpm", [value])).toThrow(/Unsupported/);
  });
});
