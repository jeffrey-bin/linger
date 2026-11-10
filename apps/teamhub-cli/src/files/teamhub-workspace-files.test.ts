import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceHostFile } from "./host-file-system.js";
import {
  createHostTeamHubWorkingCopyStateFiles,
  createHostTeamHubWorkspaceFiles,
} from "./teamhub-workspace-files.js";

const RECORD = `${"b".repeat(64)}.json`;

vi.mock("./host-file-system.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./host-file-system.js")>();
  return { ...actual, replaceHostFile: vi.fn(actual.replaceHostFile) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
const actualFS =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const platform = process.platform;
const roots: string[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.mocked(fs.open).mockReset().mockImplementation(actualFS.open);
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFS.rename);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(runtimeWorkspacePath?: string) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "teamhub-native-files-")),
  );
  roots.push(root);
  const workspace = path.join(root, "Café space");
  await mkdir(workspace);
  const input = {
    workspacePath: workspace,
    runtimeWorkspacePath: runtimeWorkspacePath ?? workspace,
    readOnlyPaths: ["documents"],
    signal: new AbortController().signal,
  };
  return {
    root,
    workspace,
    input,
    files: createHostTeamHubWorkspaceFiles(input),
  };
}

describe("native TeamHub workspace paths", () => {
  it.each([
    "C:\\Runtime work\\Agentür",
    "\\\\server\\share\\Agentür",
    "C:\\",
    "C:\\Runtime work\\Agentür\\",
  ])("normalizes native Windows paths under %s", async (root) => {
    const f = await fixture(root);
    expect(f.files.normalize(path.win32.join(root, "Résumé result.txt"))).toBe(
      "Résumé result.txt",
    );
    expect(
      f.files.normalize(
        `${root.toLowerCase().replaceAll("\\", "/").replace(/\/$/u, "")}/Résumé result.txt`,
      ),
    ).toBe("Résumé result.txt");
    expect(() =>
      f.files.normalize(`${root.replace(/[\\/]$/u, "")}-outside\\secret`),
    ).toThrow();
    await f.files.install(
      "Résumé result.txt",
      Buffer.from("published bytes"),
      null,
    );
    expect(await f.files.read("Résumé result.txt")).toMatchObject({
      sha256: sha("published bytes"),
    });
  });

  it.each([
    "..\\secret",
    "folder\\..\\secret",
    ".TEAMHUB\\state.json",
    ".AGENTS\\private",
    "DOCUMENTS\\draft",
    "report.txt:private",
    "report.txt.",
    "folder \\report",
    "NUL",
    "CON.txt",
    "COM1.log",
    "name?",
    "folder\\\\file",
  ])("rejects Windows aliases and traversal %s", async (relative) => {
    const f = await fixture("C:\\workspace");
    expect(() => f.files.normalize(`C:\\workspace\\${relative}`)).toThrow();
  });

  it("keeps writable mappings authoritative across Windows separator and case variants", async () => {
    const f = await fixture("C:\\workspace");
    const source = path.join(f.root, "playground");
    await mkdir(source);
    await symlink(f.root, path.join(f.workspace, "Playground"), "junction");
    const files = createHostTeamHubWorkspaceFiles({
      ...f.input,
      writableMappings: [{ relativePath: "playground", sourcePath: source }],
    });
    await files.install(
      files.normalize("c:/workspace/Playground/result.txt"),
      Buffer.from("mapped"),
      null,
    );
    expect(await readFile(path.join(source, "result.txt"), "utf8")).toBe(
      "mapped",
    );
  });

  it("installs, replaces and persists working-copy records on the native filesystem", async () => {
    const f = await fixture();
    const relative = f.files.normalize(
      path.join(f.workspace, "Résumé result.txt"),
    );
    await f.files.install(relative, Buffer.from("first"), null);
    await f.files.install(relative, Buffer.from("second"), sha("first"));
    expect(await f.files.read(relative)).toMatchObject({
      content: Buffer.from("second"),
    });
    await expect(
      f.files.install(relative, Buffer.from("third"), sha("first")),
    ).rejects.toMatchObject({ code: "file_changed" });
    const state = createHostTeamHubWorkingCopyStateFiles({
      ...f.input,
      namespace: "fixture",
    });
    await state.write(RECORD, Buffer.from('{"operation_id":"fixture"}'));
    expect(Buffer.from((await state.read(RECORD, 4096))!).toString()).toBe(
      '{"operation_id":"fixture"}',
    );
    expect(await state.read(`${"c".repeat(64)}.json`, 4096)).toBeNull();
  });

  it("rejects recovery hard links and workspace directory links", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside.txt");
    await writeFile(outside, "outside");
    const state = createHostTeamHubWorkingCopyStateFiles({
      ...f.input,
      namespace: "fixture",
    });
    await state.ensure();
    await link(outside, path.join(state.key, RECORD));
    await expect(state.read(RECORD, 4096)).rejects.toMatchObject({
      code: "state_unavailable",
    });
    await symlink(f.root, path.join(f.workspace, "escape"), "junction");
    await expect(f.files.read("escape/outside.txt")).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(
      f.files.install("escape/new.txt", Buffer.from("bad"), null),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("rejects a linked metadata directory", async () => {
    const f = await fixture();
    await symlink(f.root, path.join(f.workspace, ".teamhub"), "junction");
    const state = createHostTeamHubWorkingCopyStateFiles({ ...f.input });
    await expect(state.ensure()).rejects.toMatchObject({
      code: "state_unavailable",
    });
  });

  it.each(["EBUSY", "EACCES", "EPERM"])(
    "recovers a short Windows read lock (%s)",
    async (code) => {
      const f = await fixture();
      const target = path.join(f.workspace, "book.xlsx");
      await writeFile(target, "first");
      Object.defineProperty(process, "platform", { value: "win32" });
      let locked = true;
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        if (args[0] === target && locked) {
          locked = false;
          throw Object.assign(new Error("sharing violation"), { code });
        }
        return actualFS.open(...args);
      });
      await f.files.install("book.xlsx", Buffer.from("second"), sha("first"));
      expect(await readFile(target, "utf8")).toBe("second");
      expect(await readdir(f.workspace)).toEqual(["book.xlsx"]);
    },
  );

  it("reports a persistent Windows read lock without leaving temporary files", async () => {
    const f = await fixture();
    const target = path.join(f.workspace, "book.xlsx");
    await writeFile(target, "first");
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (args[0] === target)
        throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
      return actualFS.open(...args);
    });
    await expect(
      f.files.install("book.xlsx", Buffer.from("second"), sha("first")),
    ).rejects.toMatchObject({ code: "file_in_use" });
    expect(await readFile(target, "utf8")).toBe("first");
    expect(await readdir(f.workspace)).toEqual(["book.xlsx"]);
  });

  it("preserves an edit made while a Windows read lock clears", async () => {
    const f = await fixture();
    const target = path.join(f.workspace, "book.xlsx");
    await writeFile(target, "first");
    Object.defineProperty(process, "platform", { value: "win32" });
    let locked = true;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (args[0] === target && locked) {
        locked = false;
        await writeFile(target, "local edit");
        throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
      }
      return actualFS.open(...args);
    });
    await expect(
      f.files.install("book.xlsx", Buffer.from("second"), sha("first")),
    ).rejects.toMatchObject({ code: "file_changed" });
    expect(await readFile(target, "utf8")).toBe("local edit");
    expect(await readdir(f.workspace)).toEqual(["book.xlsx"]);
  });

  it("rechecks the expected SHA after a Windows replacement lock", async () => {
    const f = await fixture();
    const target = path.join(f.workspace, "book.xlsx");
    await writeFile(target, "first");
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.mocked(fs.rename).mockImplementationOnce(async () => {
      await writeFile(target, "local edit");
      throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
    });
    await expect(
      f.files.install("book.xlsx", Buffer.from("second"), sha("first")),
    ).rejects.toMatchObject({ code: "file_changed" });
    expect(await readFile(target, "utf8")).toBe("local edit");
    expect(await readdir(f.workspace)).toEqual(["book.xlsx"]);
  });

  it.runIf(process.platform === "win32").each([
    { milliseconds: 1_000, expected: "second" },
    { milliseconds: 6_000, expected: "first" },
  ])(
    "handles a real exclusive Windows lock for $milliseconds ms",
    async ({ milliseconds, expected }) => {
      const f = await fixture();
      const target = path.join(f.workspace, "book.xlsx");
      await writeFile(target, "first");
      const exited = await holdExclusiveWindowsFile(target, milliseconds);
      try {
        const installing = f.files.install(
          "book.xlsx",
          Buffer.from("second"),
          sha("first"),
        );
        if (expected === "second") await installing;
        else
          await expect(installing).rejects.toMatchObject({
            code: "file_in_use",
          });
      } finally {
        await exited.wait;
      }
      expect(await readFile(target, "utf8")).toBe(expected);
      expect(await readdir(f.workspace)).toEqual(["book.xlsx"]);
    },
    20_000,
  );

  it("reports a Windows target that stays open in another program", async () => {
    const f = await fixture();
    await f.files.install("book.xlsx", Buffer.from("first"), null);
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.mocked(replaceHostFile).mockRejectedValueOnce(
      Object.assign(new Error("busy"), { code: "EBUSY" }),
    );
    try {
      await expect(
        f.files.install("book.xlsx", Buffer.from("second"), sha("first")),
      ).rejects.toMatchObject({
        code: "file_in_use",
        message: expect.stringContaining("open in another program"),
      });
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
    expect(await readdir(f.workspace)).toEqual(["book.xlsx"]);
    expect(await readFile(path.join(f.workspace, "book.xlsx"), "utf8")).toBe(
      "first",
    );
  });
});

async function holdExclusiveWindowsFile(target: string, milliseconds: number) {
  const child = spawn(
    path.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'; $f = [IO.File]::Open($env:HOLD_PATH, 'Open', 'Read', 'None'); try { [Console]::Out.WriteLine('held'); Start-Sleep -Milliseconds ${milliseconds} } finally { $f.Close() }`,
    ],
    { env: { ...process.env, HOLD_PATH: target }, windowsHide: true },
  );
  const wait = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Lock holder exited with ${code}`)),
    );
  });
  await Promise.race([
    new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
    wait.then(() => {
      throw new Error("Lock holder exited before acquiring the file");
    }),
  ]);
  return { wait };
}
