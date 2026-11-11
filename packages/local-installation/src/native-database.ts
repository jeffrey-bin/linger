import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  atomicPrivate,
  privateDirectory,
  readPrivate,
  type Instance,
} from "./instance.js";
import { inspectNativeProcess, startNativeProcess } from "./native-process.js";
import { runProcess } from "./process.js";
import { parseEnv } from "node:util";

/** The PostgreSQL program `name` in `bin`, with `.exe` on Windows. */
export function postgresProgram(
  bin: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
) {
  return path.join(bin, platform === "win32" ? `${name}.exe` : name);
}

// postgres.exe refuses to run with an elevated token ("Run as administrator",
// or an administrator account with UAC off). Elevated tokens carry the High
// (or System) mandatory label, which `whoami` names by SID in every language.
export async function windowsElevated(
  run: typeof runProcess = runProcess,
): Promise<boolean> {
  const whoami = path.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "whoami.exe",
  );
  const result = await run(whoami, ["/groups", "/fo", "csv", "/nh"], {
    timeoutMs: 10_000,
  }).catch(() => undefined);
  return (
    result?.code === 0 && /S-1-16-(12288|16384)\b/.test(result.stdout ?? "")
  );
}

export async function prepareNativeDatabase(options: {
  instance: Instance;
  postgresBin: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onOutput: (chunk: string) => void;
}): Promise<void> {
  const { instance, postgresBin, signal } = options;
  if (process.getuid?.() === 0)
    throw new Error(
      "Native PostgreSQL must run as a normal user; run Linger without sudo.",
    );
  if (process.platform === "win32" && (await windowsElevated()))
    throw new Error(
      "Native PostgreSQL cannot run as administrator; start Linger normally, not with Run as administrator.",
    );
  if (!instance.source || instance.mode !== "source-native")
    throw new Error("Native database needs a native source instance");
  const port = instance.source.ports.postgres;
  const data = path.join(instance.root, "native/postgres-data");
  const passwordFile = path.join(instance.root, "native/postgres-password");
  await privateDirectory(data);
  const password = parseEnv(
    (await readPrivate(path.join(instance.root, "services.env")))!,
  ).LINGER_POSTGRES_PASSWORD!;
  await atomicPrivate(passwordFile, `${password}\n`);
  let initialized = false;
  try {
    const version = path.join(data, "PG_VERSION");
    const info = await lstat(version);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (await readFile(version, "utf8")).trim() !== "17"
    )
      throw new Error(
        "This native instance contains an unsupported PostgreSQL data directory.",
      );
    initialized = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const env = { ...options.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "3" };
  const command = async (name: string, args: string[], timeoutMs = 60_000) => {
    const result = await runProcess(postgresProgram(postgresBin, name), args, {
      env,
      signal,
      timeoutMs,
      onOutput: options.onOutput,
    });
    if (result.code !== 0)
      throw new Error(
        `Native PostgreSQL ${name} failed; inspect the instance log.`,
      );
    return result;
  };
  if (!initialized)
    await command("initdb", [
      "--pgdata",
      data,
      "--username",
      "simplexai",
      "--pwfile",
      passwordFile,
      "--auth-host",
      "scram-sha-256",
      "--auth-local",
      "scram-sha-256",
      "--encoding",
      "UTF8",
      "--no-locale",
    ]);
  await startNativeProcess({
    root: instance.root,
    name: "postgres",
    executable: postgresProgram(postgresBin, "postgres"),
    args: [
      "-D",
      data,
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-k",
      "",
      "-c",
      "max_connections=100",
      "-c",
      "shared_buffers=128MB",
      "-c",
      "jit=off",
    ],
    cwd: instance.root,
    env,
    signal,
    redactions: [password],
  });
  const connection = [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--username",
    "simplexai",
    "--dbname",
    "postgres",
  ];
  const deadline = Date.now() + 30_000;
  for (;;) {
    signal.throwIfAborted();
    if (!(await inspectNativeProcess(instance.root, "postgres")).running)
      throw new Error("Native PostgreSQL stopped; inspect its instance log.");
    const ready = await runProcess(
      postgresProgram(postgresBin, "pg_isready"),
      connection,
      { env, signal, timeoutMs: 5_000 },
    );
    if (ready.code === 0) break;
    if (Date.now() >= deadline)
      throw new Error("Native PostgreSQL did not become ready.");
    await delay(200, undefined, { signal });
  }
  const present = await command("psql", [
    ...connection,
    "--tuples-only",
    "--no-align",
    "--command",
    "SELECT 1 FROM pg_database WHERE datname='simplexai'",
  ]);
  if (present.stdout.trim() !== "1")
    await command("createdb", [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--username",
      "simplexai",
      "simplexai",
    ]);
}
