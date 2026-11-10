import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readConnectorFile,
  snapshotConnectorFiles,
  validateLocalFiles,
} from "./connector-files.js";

const roots: string[] = [];
async function root() {
  const value = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "teamhub-attach-")),
  );
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("connector attachments", () => {
  it("uploads a file from a Task playground projected through a directory symlink", async () => {
    const cwd = await root();
    const task = await root();
    await mkdir(path.join(cwd, "playground"));
    await writeFile(path.join(task, "report.md"), "task report");
    await symlink(task, path.join(cwd, "playground", "workitem_1"), "junction");

    const paths = await validateLocalFiles(
      ["./playground/workitem_1/report.md"],
      cwd,
    );
    expect(paths).toEqual([path.join(task, "report.md")]);
    const [file] = await snapshotConnectorFiles(paths);
    expect(Buffer.from(await readConnectorFile(file!)).toString()).toBe(
      "task report",
    );
  });

  it("still rejects an attachment that is itself a symlink", async () => {
    const cwd = await root();
    await writeFile(path.join(cwd, "report.md"), "report");
    await symlink(path.join(cwd, "report.md"), path.join(cwd, "alias.md"));
    await expect(validateLocalFiles(["alias.md"], cwd)).rejects.toThrow(
      /not a directory or symlink/,
    );
  });
});
