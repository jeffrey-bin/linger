import { writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
export async function writeLauncher(
  stateDir: string,
  origin: string,
  token: string,
) {
  const file = path.join(stateDir, "launch.html"),
    temporary = path.join(stateDir, `launch.${randomUUID()}.tmp`);
  const target = `${origin}/#token=${encodeURIComponent(token)}`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Open Linger installer</title><meta http-equiv="refresh" content="0;url=${target}"><a href="${target}">Open Linger installer</a></html>`;
  try {
    await writeFile(temporary, html, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return file;
}
