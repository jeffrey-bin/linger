import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open } from "node:fs/promises";
import path from "node:path";
import { readExactHostFile } from "./files/host-file-reader.js";
import {
  syncHostDirectory,
  protectWindowsDirectories,
} from "./files/host-file-system.js";
import { ConnectorError as CliError } from "./errors.js";
import {
  record,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";

const maxBytes = 16 * 1024 * 1024;
async function directory(runtime: ConnectorRuntime): Promise<string> {
  let dir = runtime.context.stateRoot;
  const dirs = [];
  for (const part of [
    ".teamhub",
    "connector-pages",
    createHash("sha256")
      .update(runtime.context.client.config.identityKey)
      .digest("hex"),
  ]) {
    dir = path.join(dir, part);
    await mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new CliError(
        "state_unavailable",
        "The private pagination directory is invalid.",
      );
    dirs.push(dir);
  }
  await protectWindowsDirectories(dirs);
  return dir;
}
// Some provider tools have no page-size control. Retain unconsumed rows in an
// immutable private snapshot; never hide, skip, or expose their bodies in cursors.
export async function sliceConnectorPage(
  runtime: ConnectorRuntime,
  state: Json,
  limit: number,
  load: () => Promise<{ rows: Json[]; token?: unknown }>,
): Promise<{ rows: Json[]; next?: Json }> {
  const dir = await directory(runtime);
  let rows: Json[],
    token: unknown,
    offset = 0,
    page: string;
  if (state.page !== undefined) {
    if (
      typeof state.page !== "string" ||
      !/^[a-f0-9]{64}$/u.test(state.page) ||
      !Number.isSafeInteger(state.offset) ||
      Number(state.offset) < 1
    )
      throw new CliError("cursor_mismatch", "Invalid private page cursor.");
    const snap = await readExactHostFile(
      dir,
      state.page + ".json",
      maxBytes,
      new AbortController().signal,
    );
    if (snap.sha256 !== state.page)
      throw new CliError("state_unavailable", "The saved page bytes changed.");
    const saved = record(
      JSON.parse(Buffer.from(snap.content).toString("utf8")),
    );
    if (
      saved.connection !== runtime.account.connection_id ||
      saved.queryKey !== runtime.pageKey ||
      !Array.isArray(saved.rows)
    )
      throw new CliError(
        "cursor_mismatch",
        "This page belongs to another account.",
      );
    rows = saved.rows.map((x) => record(x));
    token = saved.token;
    offset = Number(state.offset);
    page = state.page;
    if (offset >= rows.length)
      throw new CliError(
        "cursor_mismatch",
        "The saved page offset is invalid.",
      );
  } else {
    const loaded = await load();
    rows = loaded.rows;
    token = loaded.token;
    const bytes = Buffer.from(
      JSON.stringify({
        connection: runtime.account.connection_id,
        queryKey: runtime.pageKey,
        rows,
        token: token ?? null,
      }),
    );
    if (bytes.length > maxBytes)
      throw new CliError(
        "too_large",
        "The provider page exceeds the private pagination limit.",
      );
    page = createHash("sha256").update(bytes).digest("hex");
    if (rows.length > limit) {
      try {
        const file = await open(
          path.join(dir, page + ".json"),
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        await syncHostDirectory(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
  }
  const selected = rows.slice(offset, offset + limit);
  return {
    rows: selected,
    ...(offset + limit < rows.length
      ? { next: { page, offset: offset + limit } }
      : token
        ? { next: { token } }
        : {}),
  };
}
