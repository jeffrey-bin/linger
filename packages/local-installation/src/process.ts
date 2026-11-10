import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { spawn } from "node:child_process";
export function windowsTreeTermination(
  child: {
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  },
  systemRoot = process.env.SystemRoot ?? "C:\\Windows",
): { command: string; args: string[] } | undefined {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0)
    throw new Error("Invalid owned process identifier");
  return {
    command: path.win32.join(systemRoot, "System32", "taskkill.exe"),
    args: ["/PID", String(child.pid), "/T", "/F"],
  };
}
export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  capture?: boolean;
  /** Private data sent directly to child stdin; never included in argv or env. */
  input?: string;
  inputStream?: Readable;
  /** Only terminal-driven system authorization may read from the controlling TTY. */
  inheritInput?: boolean;
  onOutput?: (chunk: string) => void;
}
export async function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (options.signal?.aborted)
    throw new DOMException("Interrupted", "AbortError");
  if (
    (options.input !== undefined || options.inputStream) &&
    options.inheritInput
  )
    throw new Error("Command input cannot also inherit terminal input");
  if (options.input !== undefined && options.inputStream)
    throw new Error("Command input sources are mutually exclusive");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: process.platform !== "win32" && !options.inheritInput,
      windowsHide: true,
      stdio: [
        options.inheritInput
          ? "inherit"
          : options.input !== undefined || options.inputStream
            ? "pipe"
            : "ignore",
        "pipe",
        "pipe",
      ],
    });
    let stdout = "",
      stderr = "",
      failure: Error | undefined,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === "win32") {
          const invocation = windowsTreeTermination(child);
          if (!invocation) return;
          // Only the child created above is targeted. /T includes native
          // forwarding launchers' Node children; killing just the wrapper leaks them.
          const cleanup = spawn(invocation.command, invocation.args, {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
          cleanup.once("error", () => {
            try {
              child.kill(signal);
            } catch {
              /* Already gone. */
            }
          });
          return;
        }
        if (child.pid)
          process.kill(options.inheritInput ? child.pid : -child.pid, signal);
      } catch {
        /* The owned process tree has already exited. */
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 500);
      killTimer.unref();
    };
    const abort = () => stop(new DOMException("Interrupted", "AbortError"));
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = options.timeoutMs
      ? setTimeout(
          () =>
            stop(
              Object.assign(new Error("Command timed out"), {
                code: "COMMAND_TIMEOUT",
              }),
            ),
          options.timeoutMs,
        )
      : undefined;
    const output = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const value = chunk.toString();
      if (
        options.capture !== false &&
        stdout.length + stderr.length + value.length > 2_000_000
      ) {
        stop(new Error("Command output exceeded limit"));
        return;
      }
      if (options.capture !== false) {
        if (stream === "stdout") stdout += value;
        else stderr += value;
      }
      options.onOutput?.(value);
    };
    child.stdout!.on("data", (chunk: Buffer) => output(chunk, "stdout"));
    child.stderr!.on("data", (chunk: Buffer) => output(chunk, "stderr"));
    child.once("error", () => {
      failure = new Error("Command executable unavailable");
    });
    if (options.inputStream) {
      void pipeline(options.inputStream, child.stdin!).catch(() =>
        stop(new Error("Command archive input unavailable")),
      );
    }
    if (options.input !== undefined) {
      child.stdin!.on("error", () =>
        stop(new Error("Command stdin unavailable")),
      );
      child.stdin!.end(options.input);
    }
    child.once("close", (code) => {
      if (failure) kill("SIGKILL");
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ stdout, stderr, code: code ?? 5 });
    });
  });
}
