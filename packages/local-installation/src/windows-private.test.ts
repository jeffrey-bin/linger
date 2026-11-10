import { expect, it, vi } from "vitest";
import {
  windowsPrivatePath,
  WINDOWS_PRIVATE_SCRIPT,
} from "./windows-private.js";
it("sends paths through stdin and runs a fixed encoded ACL program", async () => {
  const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  await windowsPrivatePath(
    "C:\\Users\\person\\private's",
    "directory",
    true,
    run,
  );
  expect(run.mock.calls[0]![1].join(" ")).not.toContain("person");
  expect(run.mock.calls[0]![2].input).toContain("person");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("[Console]::InputEncoding");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("ReparsePoint");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("GetCurrent().User");
  expect(WINDOWS_PRIVATE_SCRIPT).toContain("AccessControlSections]::Access");
});
it("fails closed without disclosing command diagnostics", async () => {
  const run = vi.fn().mockResolvedValue({ code: 1, stderr: "sensitive path" });
  await expect(
    windowsPrivatePath("private", "file", false, run),
  ).rejects.toThrow("Windows private path validation failed");
});
it("ignores inherit-only ACEs only for effective ancestor permissions", () => {
  const ancestors = WINDOWS_PRIVATE_SCRIPT.slice(
    WINDOWS_PRIVATE_SCRIPT.indexOf("while ($parent)"),
    WINDOWS_PRIVATE_SCRIPT.indexOf("if ($request.repair)"),
  );
  const target = WINDOWS_PRIVATE_SCRIPT.slice(
    WINDOWS_PRIVATE_SCRIPT.indexOf("$currentAllowed = $false"),
  );
  expect(ancestors).toContain(
    "$rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly",
  );
  expect(target).not.toContain("PropagationFlags");
  expect(target).toContain("Non-private permissions");
});
