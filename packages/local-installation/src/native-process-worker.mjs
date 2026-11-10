// Persistent owner of one native service group. Only redacted lines reach disk.
import { spawn } from "node:child_process";
import { constants, closeSync, writeSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { lineRedactor } from "./redaction.ts";
import { nativeLeaseProcesses } from "./native-process-identity.ts";

const file = process.argv[2];
// Windows reports neither owner nor mode bits; the native directory ACL,
// repaired by privateDirectory, is what keeps these files private there.
const privateOwner = (info) =>
  process.platform === "win32" ||
  (info.uid === process.getuid?.() && !(info.mode & 0o077));
let output;
try {
  const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let job;
  try {
    const info = await input.stat();
    if (!info.isFile() || !privateOwner(info))
      throw new Error("Unsafe native job");
    job = JSON.parse(await input.readFile("utf8"));
  } finally {
    await input.close();
  }
  await rm(file);
  if (
    typeof job.executable !== "string" ||
    !Array.isArray(job.args) ||
    job.args.some((value) => typeof value !== "string") ||
    typeof job.cwd !== "string" ||
    typeof job.log !== "string" ||
    !job.env ||
    job.env.LINGER_NATIVE_PROCESS_LEASE !==
      process.env.LINGER_NATIVE_PROCESS_LEASE ||
    !Array.isArray(job.redactions)
  )
    throw new Error("Invalid native job");
  output = await open(
    job.log,
    constants.O_CREAT |
      constants.O_APPEND |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  const info = await output.stat();
  if (!info.isFile() || !privateOwner(info))
    throw new Error("Unsafe native log");
  const secrets = job.redactions
    .filter((value) => typeof value === "string" && value.length)
    .sort((a, b) => b.length - a.length);
  let loggingFailed = false;
  const streams = [0, 1].map(() =>
    lineRedactor((line) => {
      if (loggingFailed) return;
      for (const secret of secrets)
        line = line.replaceAll(secret, "[REDACTED]");
      try {
        writeSync(output.fd, line);
      } catch {
        // Keep draining the pipes and retain the process owner even when disk
        // writes fail. Never fall back to an unredacted stream or crash here.
        loggingFailed = true;
      }
    }),
  );
  // Stay group leader after the service exits: descendants may still be alive.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  const child = spawn(job.executable, job.args, {
    cwd: job.cwd,
    env: job.env,
    // This detached supervisor has no console, so on Windows the service
    // would open a visible one that air, PowerShell and go then share.
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => streams[0].write(chunk));
  child.stderr.on("data", (chunk) => streams[1].write(chunk));
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  process.send?.("ready");
  process.on("disconnect", () => {});
  child.on("close", () => {
    for (const stream of streams) stream.flush();
    const check = async () => {
      try {
        // Air and other watchers create new groups. Their inherited lease
        // keeps ownership provable even after their original parent exits.
        if (
          !(await nativeLeaseProcesses(process.env.LINGER_NATIVE_PROCESS_LEASE))
            .length
        ) {
          closeSync(output.fd);
          process.exit(0);
        }
      } catch {
        /* Keep the owner alive when group membership is uncertain. */
      }
      setTimeout(check, 100);
    };
    void check();
  });
} catch {
  process.send?.("failed");
  await output?.close().catch(() => {});
  process.exit(1);
}
