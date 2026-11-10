import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicPrivate, privateDirectory, type Instance } from "./instance.js";
import { runProcess } from "./process.js";
import { lineRedactor } from "./redaction.js";

function meetsMinimum(output: string, minimumVersion: string): boolean {
  if (output.trim() === "linger-computer dev") return true;
  const version = /^linger-computer (\d+)\.(\d+)\.(\d+)\s*$/u.exec(
    output.trim(),
  );
  if (!version) return false;
  const minimum = minimumVersion.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = Number(version[index + 1]) - minimum[index]!;
    if (difference !== 0) return difference > 0;
  }
  return true;
}
async function installerScript(
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Checkout Computer installer download is unavailable.");
  }
  const maximum = 2 * 1024 * 1024;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum)
        throw new Error("Computer installer exceeds size limit.");
      chunks.push(chunk.value);
    }
    if (!bytes) throw new Error("Checkout Computer installer is empty.");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Caller holds the lock. The checkout serves and verifies its own release digests. */
export async function prepareSourceComputer(
  instance: Instance,
  signal: AbortSignal,
  onOutput?: (value: string) => void,
): Promise<void> {
  signal.throwIfAborted();
  if (!instance.source?.repo)
    throw new Error(
      "Computer source installation requires a validated source instance.",
    );
  const management = await readFile(
    path.join(
      instance.source.repo,
      "apps/node-services/src/agent/runner-gateway/local-computer-management.ts",
    ),
    "utf8",
  );
  // The transport minimum only permits connection for self-update. Source
  // installation requires the backend's current-work minimum instead.
  const minimum =
    /\bMINIMUM_CURRENT_COMPUTER_VERSION\s*=\s*"((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))"/u.exec(
      management,
    )?.[1];
  if (!minimum)
    throw new Error("Source checkout has no valid Computer admission policy.");
  const suitable = async (executable: string): Promise<boolean> => {
    try {
      const result = await runProcess(executable, ["version"], {
        signal,
        timeoutMs: 15_000,
      });
      return result.code === 0 && meetsMinimum(result.stdout, minimum);
    } catch {
      signal.throwIfAborted();
      return false;
    }
  };
  if (await suitable(instance.computerExecutable)) return;
  if (
    instance.computerExecutable !== "linger-computer" &&
    (await suitable("linger-computer"))
  ) {
    instance.computerExecutable = "linger-computer";
    await atomicPrivate(
      path.join(instance.root, "instance.json"),
      JSON.stringify(instance, null, 2) + "\n",
    );
    return;
  }
  const directory = path.join(instance.root, "computer");
  const bin = path.join(directory, "bin");
  const data = path.join(directory, "release");
  await privateDirectory(directory);
  await privateDirectory(bin);
  await privateDirectory(data);
  const windows = process.platform === "win32";
  const script = path.join(directory, windows ? "install.ps1" : "install.sh");
  await atomicPrivate(
    script,
    await installerScript(
      `${instance.origin}/install/linger-computer.${windows ? "ps1" : "sh"}`,
      signal,
    ),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("LINGER_COMPUTER_"),
    ),
  );
  Object.assign(env, {
    LINGER_COMPUTER_DATA_DIR: data,
    LINGER_COMPUTER_BIN_DIR: bin,
    LINGER_COMPUTER_CONFIG: instance.computerConfig,
    LINGER_WEB_URL: instance.origin,
    LINGER_COMPUTER_INSECURE_DEVELOPMENT_ORIGIN: instance.origin,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const output = lineRedactor((value) => onOutput?.(value));
  try {
    const result = await runProcess(
      windows ? "powershell.exe" : "bash",
      windows
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
          ]
        : [script],
      {
        signal,
        env,
        timeoutMs: 15 * 60_000,
        capture: false,
        onOutput: (value) => output.write(value),
      },
    );
    signal.throwIfAborted();
    const executable = path.join(
      bin,
      windows ? "linger-computer.exe" : "linger-computer",
    );
    if (result.code !== 0 || !(await suitable(executable)))
      throw new Error(
        `Computer >=${minimum} is not available from this checkout for this platform. Services and instance data have been preserved; check the official release and retry.`,
      );
    instance.computerExecutable = executable;
    await atomicPrivate(
      path.join(instance.root, "instance.json"),
      JSON.stringify(instance, null, 2) + "\n",
    );
  } finally {
    output.flush();
  }
}
