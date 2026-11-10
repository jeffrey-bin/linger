import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { windowsPrivatePath } from "./windows-private.js";
import { runProcess } from "./process.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "linger-private-acl-"));
  roots.push(root);
  await windowsPrivatePath(root, "directory", true);
  return root;
}
it.skipIf(process.platform !== "win32")(
  "creates a protected user/SYSTEM DACL and accepts inherited private files",
  async () => {
    const root = await fixture();
    const file = path.join(root, "settings.json");
    await writeFile(file, "{}");
    await expect(windowsPrivatePath(file, "file")).resolves.toBeUndefined();
    await expect(
      windowsPrivatePath(root, "directory"),
    ).resolves.toBeUndefined();
  },
);
it.skipIf(process.platform !== "win32")(
  "rejects a junction as either the target or an ancestor",
  async () => {
    const root = await fixture();
    const junction = path.join(root, "link");
    await symlink(root, junction, "junction");
    await writeFile(path.join(root, "settings.json"), "{}");
    await expect(windowsPrivatePath(junction, "directory")).rejects.toThrow(
      /validation failed/,
    );
    await expect(
      windowsPrivatePath(path.join(junction, "settings.json"), "file"),
    ).rejects.toThrow(/validation failed/);
  },
);
it.skipIf(process.platform !== "win32")(
  "rejects an ACL allowing another identity to read private state",
  async () => {
    const root = await fixture();
    const file = path.join(root, "settings.json");
    await writeFile(file, "{}");
    const script =
      "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $item=[IO.FileInfo]::new($p); $a=Get-Acl -LiteralPath $p; $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow')); $item.SetAccessControl($a)";
    const changed = await runProcess(
      path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { input: file, timeoutMs: 30000 },
    );
    expect(changed.code).toBe(0);
    await expect(windowsPrivatePath(file, "file")).rejects.toThrow(
      /validation failed/,
    );
  },
);
it.skipIf(process.platform !== "win32")(
  "accepts inherit-only ancestor Modify ACEs but rejects effective ancestor access and broad private target inheritance",
  async () => {
    const root = await fixture();
    const child = path.join(root, "private");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(child);
    await windowsPrivatePath(child, "directory", true);
    const mutate = async (propagation: "InheritOnly" | "None") => {
      const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::In.ReadToEnd(); $item=[IO.DirectoryInfo]::new($p); $a=Get-Acl -LiteralPath $p; $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'),'Modify','ContainerInherit,ObjectInherit','${propagation}','Allow')); $item.SetAccessControl($a)`;
      const changed = await runProcess(
        path.win32.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { input: root, timeoutMs: 30000 },
      );
      expect(changed.code).toBe(0);
    };
    await mutate("InheritOnly");
    await expect(
      windowsPrivatePath(child, "directory"),
    ).resolves.toBeUndefined();
    // A private target also owns future descendants, so broad inheritance on
    // the target remains forbidden even when it is inherit-only.
    await expect(windowsPrivatePath(root, "directory")).rejects.toThrow(
      /validation failed/,
    );
    await mutate("None");
    await expect(windowsPrivatePath(child, "directory")).rejects.toThrow(
      /validation failed/,
    );
  },
);
