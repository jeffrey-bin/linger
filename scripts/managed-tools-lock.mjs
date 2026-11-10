import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// A filesystem bakery lock: each contender owns a unique, never reused claim.
// Publishing the directory announces ticket selection before publishing its ticket.
// Dead claims can be removed concurrently without unlinking a new owner's lock.
export async function acquireManagedToolsLock(root, timeoutMs = 30_000) {
  const directory = path.join(root, ".locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = `${process.pid}-${randomUUID()}`;
  const claim = path.join(directory, identity);
  await mkdir(claim, { mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  try {
    const claims = await readClaims(directory, identity);
    const ticket = Math.max(0, ...claims.map((entry) => entry.ticket ?? 0)) + 1;
    await writeFile(path.join(claim, ".ticket"), String(ticket), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(path.join(claim, ".ticket"), path.join(claim, "ticket"));
    while (true) {
      const others = await readClaims(directory, identity);
      if (
        !others.some(
          (entry) =>
            entry.ticket === null ||
            entry.ticket < ticket ||
            (entry.ticket === ticket && entry.identity < identity),
        )
      ) {
        return () => rm(claim, { recursive: true, force: true });
      }
      if (Date.now() >= deadline)
        throw new Error(
          "Timed out waiting for managed tools installation lock",
        );
      await delay(20);
    }
  } catch (error) {
    await rm(claim, { recursive: true, force: true });
    throw error;
  }
}

async function readClaims(directory, identity) {
  const claims = [];
  for (const other of await readdir(directory)) {
    if (other === identity) continue;
    const match = /^(\d+)-[0-9a-f-]{36}$/u.exec(other);
    if (!match) throw new Error("Invalid managed tools lock claim");
    const claim = path.join(directory, other);
    try {
      process.kill(Number(match[1]), 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      await rm(claim, { recursive: true, force: true });
      continue;
    }
    let ticket;
    try {
      ticket = Number(await readFile(path.join(claim, "ticket"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // The claim may have finished since readdir, or still be selecting.
      try {
        await readdir(claim);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      ticket = null;
    }
    if (ticket !== null && (!Number.isSafeInteger(ticket) || ticket < 1))
      throw new Error("Invalid managed tools lock ticket");
    claims.push({ identity: other, ticket });
  }
  return claims;
}
