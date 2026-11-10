import { expect, it } from "vitest";
import { windowsTreeTermination } from "./process.js";
it("uses the fixed native taskkill tool for an owned live child tree", () => {
  expect(
    windowsTreeTermination(
      { pid: 4321, exitCode: null, signalCode: null },
      "C:\\Windows",
    ),
  ).toEqual({
    command: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/PID", "4321", "/T", "/F"],
  });
});
it("never targets a finished process or a non-process identifier", () => {
  expect(
    windowsTreeTermination({ pid: 4321, exitCode: 0, signalCode: null }),
  ).toBeUndefined();
  expect(
    windowsTreeTermination({
      pid: 4321,
      exitCode: null,
      signalCode: "SIGTERM",
    }),
  ).toBeUndefined();
  expect(
    windowsTreeTermination({
      pid: undefined,
      exitCode: null,
      signalCode: null,
    }),
  ).toBeUndefined();
  expect(() =>
    windowsTreeTermination({ pid: -1, exitCode: null, signalCode: null }),
  ).toThrow();
});
