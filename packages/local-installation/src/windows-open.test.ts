import { expect, it, vi } from "vitest";
import { openWindowsTarget } from "./windows-open.js";
it("opens Windows targets without putting OAuth tokens into argv or a command shell", async () => {
  const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  const target =
    "https://auth.example.com/authorize?state=private&redirect_uri=http%3A%2F%2Flocalhost";
  await openWindowsTarget(target, { run });
  const [executable, args, options] = run.mock.calls[0]!;
  expect(executable).toBe("powershell.exe");
  expect(Buffer.from(args.at(-1), "base64").toString("utf16le")).toContain(
    "[Console]::InputEncoding",
  );
  expect(args).not.toContain(target);
  expect(args.join(" ")).not.toContain("private");
  expect(JSON.parse(options.input)).toBe(target);
  expect(options.inheritInput).not.toBe(true);
});
it("opens Unicode and spaced Windows paths as literal input", async () => {
  const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  const target = "C:\\Users\\User Name\\Linger\\launch.html";
  await openWindowsTarget(target, { run });
  expect(JSON.parse(run.mock.calls[0]![2].input)).toBe(target);
});
it("surfaces browser launch failure without echoing private targets", async () => {
  const run = vi
    .fn()
    .mockResolvedValue({ code: 1, stdout: "", stderr: "private" });
  await expect(
    openWindowsTarget("https://example.com/?token=private", { run }),
  ).rejects.toThrow("Windows could not open the requested page");
});
