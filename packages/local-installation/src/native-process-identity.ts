import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";

const leaseKey = "LINGER_NATIVE_PROCESS_LEASE";
function runProcess(
  executable: string,
  args: string[],
  options: { timeoutMs: number },
) {
  // Inspectors must not inherit the lease and appear among the owned processes.
  const env = { ...process.env };
  delete env[leaseKey];
  return new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    execFile(
      executable,
      args,
      // Startup polls this every half second; on Windows each PowerShell
      // would otherwise open its own console window.
      {
        env,
        timeout: options.timeoutMs,
        maxBuffer: 2_000_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error && error.code !== 1)
          reject(new Error("Native process identity could not be inspected."));
        else resolve({ code: error ? 1 : 0, stdout });
      },
    );
  });
}
// Windows has no process groups and no readable foreign environment. The
// supervisor carries the lease in its command line (the job file name), and
// what it starts is found through parent links; a creation time older than
// the parent's means a reused PID, never a child.
const WINDOWS_PROCESSES = String.raw`
$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; c = $_.CreationDate.ToFileTimeUtc(); l = [string]$_.CommandLine }
} | ConvertTo-Json -Compress
`;
export interface WindowsProcess {
  pid: number;
  parent: number;
  created: number;
  command: string;
}
export async function windowsProcesses(): Promise<WindowsProcess[]> {
  const result = await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESSES],
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0)
    throw new Error("Native processes could not be enumerated.");
  const rows = JSON.parse(result.stdout || "[]") as
    | { p: number; q: number; c: number; l: string }
    | { p: number; q: number; c: number; l: string }[];
  return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
    pid: row.p,
    parent: row.q,
    created: row.c,
    command: row.l ?? "",
  }));
}
/** The supervisor holding the lease and everything it started, alive now. */
export function windowsLeaseTree(
  processes: WindowsProcess[],
  lease: string,
): WindowsProcess[] {
  const owner = processes.find((candidate) =>
    candidate.command.includes(`.${lease}.job`),
  );
  if (!owner) return [];
  const tree = [owner];
  for (let index = 0; index < tree.length; index++) {
    const parent = tree[index]!;
    for (const candidate of processes)
      if (
        candidate.parent === parent.pid &&
        candidate.created >= parent.created &&
        !tree.includes(candidate)
      )
        tree.push(candidate);
  }
  return tree;
}
/** Linux reads /proc directly: minimal hosts and containers often lack procps. */
export async function linuxProcessStates(
  ownedOnly = false,
): Promise<Array<{ pid: number; group: number; state: string }>> {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const states = await Promise.all(
    pids.map(async (pid) => {
      try {
        if (
          ownedOnly &&
          (await stat(`/proc/${pid}`)).uid !== process.getuid?.()
        )
          return undefined;
        const line = await readFile(`/proc/${pid}/stat`, "utf8");
        const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
        return {
          pid: Number(pid),
          group: Number(fields[2]),
          state: fields[0] ?? "",
        };
      } catch {
        return undefined; // Exited while listing.
      }
    }),
  );
  return states.filter((state) => state !== undefined);
}
export async function nativeProcessIdentity(
  pid: number,
  lease: string,
  requireLeader = true,
): Promise<string | undefined> {
  try {
    if (process.platform === "win32") {
      const tree = windowsLeaseTree(await windowsProcesses(), lease);
      const found = tree.find((candidate) => candidate.pid === pid);
      if (!found || (requireLeader && found !== tree[0])) return;
      return `win32:${found.pid}:${found.created}`;
    }
    if (process.platform === "linux") {
      const [stat, status, environment] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/status`, "utf8"),
        readFile(`/proc/${pid}/environ`, "utf8"),
      ]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || (requireLeader && Number(fields[2]) !== pid))
        return;
      const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
      if (Number(uid) !== process.getuid?.()) return;
      if (!environment.split("\0").includes(`${leaseKey}=${lease}`)) return;
      return `linux:${uid}:${fields[19]}`;
    }
    if (process.platform === "darwin") {
      const [identity, environment] = await Promise.all([
        runProcess(
          "/bin/ps",
          ["-p", String(pid), "-o", "lstart=,uid=,pgid=,stat="],
          { timeoutMs: 5_000 },
        ),
        // Read only this candidate. Never print the output: it contains
        // environment values. The unguessable launch lease survives execve.
        runProcess("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
          timeoutMs: 5_000,
        }),
      ]);
      if (
        identity.code !== 0 ||
        environment.code !== 0 ||
        !environment.stdout.includes(`${leaseKey}=${lease}`)
      )
        return;
      const parts = identity.stdout.trim().split(/\s+/);
      if (
        Number(parts[5]) !== process.getuid?.() ||
        (requireLeader && Number(parts[6]) !== pid) ||
        parts[7]?.startsWith("Z")
      )
        return;
      return `darwin:${parts.slice(0, 7).join(":")}`;
    }
  } catch {
    return;
  }
}

export async function nativeLeaseProcesses(
  lease: string,
): Promise<Array<{ pid: number; birth: string }>> {
  if (process.platform === "win32")
    // Descendants that outlive their parent keep a dead parent PID and drop
    // out of the tree; Windows does not reparent them.
    return windowsLeaseTree(await windowsProcesses(), lease).flatMap(
      (candidate) =>
        candidate.pid === process.pid
          ? []
          : [
              {
                pid: candidate.pid,
                birth: `win32:${candidate.pid}:${candidate.created}`,
              },
            ],
    );
  let candidates: number[];
  if (process.platform === "linux")
    // nativeProcessIdentity still checks the real owner and lease per candidate.
    candidates = (await linuxProcessStates(true)).flatMap(({ pid, state }) =>
      pid !== process.pid && state !== "Z" ? [pid] : [],
    );
  else {
    const result = await runProcess("/bin/ps", ["-axo", "pid=,uid=,stat="], {
      timeoutMs: 5000,
    });
    if (result.code !== 0)
      throw new Error("Native processes could not be enumerated.");
    candidates = result.stdout
      .trim()
      .split("\n")
      .flatMap((line) => {
        const [pid, uid, state] = line.trim().split(/\s+/);
        return Number(uid) === process.getuid?.() &&
          Number(pid) !== process.pid &&
          !state?.startsWith("Z")
          ? [Number(pid)]
          : [];
      });
  }
  if (process.platform === "darwin") {
    const leased: number[] = [];
    // Batch the private environment lookup, then fetch a birth identity only
    // for matching leases. One ps per host process makes ordinary down slow.
    for (let offset = 0; offset < candidates.length; offset += 32) {
      const listing = await runProcess(
        "/bin/ps",
        [
          "eww",
          "-p",
          candidates.slice(offset, offset + 32).join(","),
          "-o",
          "pid=,command=",
        ],
        { timeoutMs: 5000 },
      );
      for (const line of listing.stdout.split("\n")) {
        const pid = /^\s*(\d+)\s/.exec(line)?.[1];
        if (pid && line.includes(`${leaseKey}=${lease}`))
          leased.push(Number(pid));
      }
    }
    candidates = leased;
  }
  const owned: Array<{ pid: number; birth: string }> = [];
  // Bound ps concurrency on hosts with many processes; their environment stays private.
  for (let offset = 0; offset < candidates.length; offset += 8) {
    const batch = await Promise.all(
      candidates.slice(offset, offset + 8).map(async (pid) => {
        const birth = await nativeProcessIdentity(pid, lease, false);
        return birth ? { pid, birth } : undefined;
      }),
    );
    for (const value of batch) if (value) owned.push(value);
  }
  return owned;
}
