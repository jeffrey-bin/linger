import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { atomicPrivate, privateDirectory, readPrivate } from "./instance.js";
import { runProcess } from "./process.js";
import {
  linuxProcessStates,
  nativeProcessIdentity as observed,
  nativeLeaseProcesses,
} from "./native-process-identity.js";

export type NativeService =
  | "postgres"
  | "livekit"
  | "teamhub"
  | "node-services"
  | "web";
const services = new Set([
  "postgres",
  "livekit",
  "teamhub",
  "node-services",
  "web",
]);
interface Lease {
  schemaVersion: 1;
  name: NativeService;
  pid: number;
  birth: string;
  lease: string;
  configuration: string;
}
export interface NativeProcessState {
  running: boolean;
  pid?: number;
}
const leaseKey = "LINGER_NATIVE_PROCESS_LEASE";
function paths(root: string, name: NativeService) {
  if (!services.has(name)) throw new Error("Invalid native service");
  return {
    record: path.join(root, "native", "processes", `${name}.json`),
    log: path.join(root, "native", "logs", `${name}.log`),
  };
}
async function stored(
  root: string,
  name: NativeService,
): Promise<Lease | undefined> {
  const text = await readPrivate(paths(root, name).record);
  if (!text) return;
  const record = JSON.parse(text) as Lease;
  if (
    record.schemaVersion !== 1 ||
    record.name !== name ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 2 ||
    typeof record.birth !== "string" ||
    !record.birth ||
    !/^[a-f0-9]{64}$/.test(record.lease) ||
    !/^[a-f0-9]{64}$/.test(record.configuration)
  )
    throw new Error("Invalid native process identity record");
  return record;
}
async function stillLive(pid: number): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      // Windows has no zombies; an exited PID is gone.
    } else if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    } else {
      const state = await runProcess(
        "/bin/ps",
        ["-p", String(pid), "-o", "stat="],
        { timeoutMs: 5_000 },
      );
      if (state.code === 0 && state.stdout.trim().startsWith("Z")) return false;
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function groupLive(group: number): Promise<boolean> {
  // Windows has no process groups; the leader is the whole group.
  if (process.platform === "win32") return stillLive(group);
  if (process.platform === "linux")
    return (await linuxProcessStates()).some(
      (process) => process.group === group && process.state !== "Z",
    );
  const result = await runProcess("/bin/ps", ["-axo", "pid=,pgid=,stat="], {
    timeoutMs: 5_000,
  });
  if (result.code !== 0)
    throw new Error(
      "Native process group could not be inspected; identity record retained.",
    );
  return result.stdout
    .trim()
    .split("\n")
    .some((line) => {
      const [, pgid, state] = line.trim().split(/\s+/);
      return Number(pgid) === group && !state?.startsWith("Z");
    });
}
export async function inspectNativeProcess(
  root: string,
  name: NativeService,
): Promise<NativeProcessState> {
  const record = await stored(root, name);
  if (!record) return { running: false };
  return {
    running: (await observed(record.pid, record.lease)) === record.birth,
    pid: record.pid,
  };
}
export async function startNativeProcess(options: {
  root: string;
  name: NativeService;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  redactions?: string[];
  /** Generated configuration the process reads; a change counts as a new configuration. */
  settings?: string;
  restartOnConfigurationChange?: boolean;
}): Promise<NativeProcessState> {
  options.signal?.throwIfAborted();
  const location = paths(options.root, options.name);
  const configuration = createHash("sha256")
    .update(
      JSON.stringify({
        executable: options.executable,
        args: options.args,
        cwd: options.cwd,
        settings: options.settings,
      }),
    )
    .digest("hex");
  const existing = await stored(options.root, options.name);
  if (
    existing &&
    (await observed(existing.pid, existing.lease)) === existing.birth
  ) {
    if (configuration !== existing.configuration) {
      if (!options.restartOnConfigurationChange)
        throw new Error(
          `Native ${options.name} configuration changed; stop this instance before restarting.`,
        );
      await stopNativeProcess(options.root, options.name);
      return startNativeProcess({
        ...options,
        restartOnConfigurationChange: false,
      });
    }
    return { running: true, pid: existing.pid };
  }
  if (existing) {
    if (
      (await stillLive(existing.pid)) ||
      (await groupLive(existing.pid)) ||
      (await nativeLeaseProcesses(existing.lease)).length
    )
      throw new Error(
        `Native ${options.name} process identity cannot be verified; refusing to replace it.`,
      );
    await rm(location.record, { force: true });
  }
  await privateDirectory(path.dirname(location.record));
  await privateDirectory(path.dirname(location.log));
  const lease = randomBytes(32).toString("hex");
  const job = path.join(
    path.dirname(location.record),
    `${options.name}.${lease}.job`,
  );
  // The worker argv contains only a private file path, never service arguments or credentials.
  await atomicPrivate(
    job,
    JSON.stringify({
      executable: options.executable,
      args: options.args,
      cwd: options.cwd,
      env: { ...options.env, [leaseKey]: lease },
      log: location.log,
      redactions: [
        ...new Set(
          [
            ...(options.redactions ?? []),
            ...Object.entries(options.env)
              .filter(([key]) =>
                /password|passwd|secret|token|api.?key|credential|database_url/i.test(
                  key,
                ),
              )
              .map(([, value]) => value),
          ].filter((value): value is string => Boolean(value)),
        ),
      ],
    }),
  );
  const worker = new URL("./native-process-worker.mjs", import.meta.url);
  if (!existsSync(worker)) {
    await rm(job, { force: true });
    throw new Error(
      "Native process supervisor is missing from this installation.",
    );
  }
  const child = spawn(process.execPath, [fileURLToPath(worker), job], {
    cwd: options.cwd,
    env: {
      [leaseKey]: lease,
      PATH: process.env.PATH,
      // Windows processes cannot load system libraries without it.
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
    },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let birth: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`Native ${options.name} supervisor start timed out.`),
          ),
        5_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      child.once("error", finish);
      child.once("exit", () =>
        finish(new Error(`Native ${options.name} supervisor failed to start.`)),
      );
      child.once("message", (message) =>
        message === "ready"
          ? finish()
          : finish(new Error(`Native ${options.name} failed to start.`)),
      );
    });
    birth = await observed(child.pid!, lease);
    if (!birth)
      throw new Error(`Native ${options.name} identity could not be verified.`);
    const record: Lease = {
      schemaVersion: 1,
      name: options.name,
      pid: child.pid!,
      birth,
      lease,
      configuration,
    };
    await atomicPrivate(location.record, JSON.stringify(record) + "\n");
    child.disconnect();
    child.unref();
    if (options.signal?.aborted) {
      await stopNativeProcess(options.root, options.name);
      options.signal.throwIfAborted();
    }
    return { running: true, pid: child.pid };
  } catch (error) {
    // A failed record write must not leave an unmanageable owned group behind.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const owned = await nativeLeaseProcesses(lease);
      if (!owned.length) break;
      const descendants = owned.filter(
        (candidate) => candidate.pid !== child.pid,
      );
      for (const candidate of descendants.length ? descendants : owned) {
        if ((await observed(candidate.pid, lease, false)) !== candidate.birth)
          continue;
        try {
          process.kill(candidate.pid, "SIGKILL");
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== "ESRCH")
            throw failure;
        }
      }
      await delay(20);
      if (Date.now() >= deadline)
        throw new Error(
          `Native ${options.name} failed to stop after identity persistence failed.`,
          { cause: error },
        );
    }
    if (child.connected) child.disconnect();
    child.unref();
    throw error;
  } finally {
    await rm(job, { force: true });
  }
}

export async function stopNativeProcess(
  root: string,
  name: NativeService,
): Promise<void> {
  const record = await stored(root, name);
  if (!record) return;
  const current = await observed(record.pid, record.lease);
  let owned = await nativeLeaseProcesses(record.lease);
  if (current !== record.birth && !owned.length) {
    if ((await stillLive(record.pid)) || (await groupLive(record.pid)))
      throw new Error(
        `Native ${name} process identity changed; refusing to signal this PID.`,
      );
    await rm(paths(root, name).record, { force: true });
    return;
  }
  const signalOwned = async (
    candidate: { pid: number; birth: string },
    signal: NodeJS.Signals,
  ) => {
    // Revalidate the birth and unguessable lease immediately before signalling.
    if (candidate.pid === record.pid && candidate.birth !== record.birth)
      return;
    if (
      (await observed(candidate.pid, record.lease, false)) !== candidate.birth
    )
      return;
    try {
      process.kill(candidate.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const interrupted = new Map<number, string>();
  const deadline = Date.now() + 12_000;
  for (;;) {
    for (const candidate of owned) {
      if (
        candidate.pid === record.pid ||
        interrupted.get(candidate.pid) === candidate.birth
      )
        continue;
      await signalOwned(candidate, "SIGINT");
      interrupted.set(candidate.pid, candidate.birth);
    }
    if (
      !owned.some((candidate) => candidate.pid !== record.pid) ||
      Date.now() >= deadline
    )
      break;
    await delay(100);
    owned = await nativeLeaseProcesses(record.lease);
  }
  // Keep the supervisor alive until separate-group descendants are reclaimed.
  const forceDeadline = Date.now() + 5_000;
  while (owned.some((candidate) => candidate.pid !== record.pid)) {
    for (const candidate of owned)
      if (candidate.pid !== record.pid) await signalOwned(candidate, "SIGKILL");
    await delay(100);
    owned = await nativeLeaseProcesses(record.lease);
    if (
      Date.now() >= forceDeadline &&
      owned.some((candidate) => candidate.pid !== record.pid)
    )
      throw new Error(
        `Native ${name} still has live descendants; identity record retained.`,
      );
  }
  const owner = owned.find((candidate) => candidate.pid === record.pid);
  if (owner) await signalOwned(owner, "SIGKILL");
  for (let count = 0; count < 30 && (await groupLive(record.pid)); count++)
    await delay(100);
  if (
    (await groupLive(record.pid)) ||
    (await nativeLeaseProcesses(record.lease)).length
  )
    throw new Error(`Native ${name} did not stop; identity record retained.`);
  await rm(paths(root, name).record, { force: true });
}
