import { spawn } from "node:child_process";

// Quote for cmd.exe, which also resolves pnpm.cmd and other PATHEXT launchers.
export function windowsCommandLine(command, args) {
  return [command, ...args]
    .map((value) => {
      if (/["%\r\n]/.test(value))
        throw new Error("Unsupported character in a Windows command argument.");
      return /^[\w./\\:=@+-]+$/.test(value) ? value : `"${value}"`;
    })
    .join(" ");
}

/**
 * POSIX replaces this process so the caller keeps the command's PID, exit
 * status and signals. Windows has no execve: run the command as a child and
 * exit with its status; the supervisor still owns it through the parent link.
 */
export function replaceProcess(command, args, env, cwd = process.cwd()) {
  if (process.platform !== "win32") {
    process.chdir(cwd);
    process.execve("/usr/bin/env", ["env", command, ...args], env);
  }
  const child = spawn(windowsCommandLine(command, args), {
    cwd,
    env,
    shell: true,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.once("exit", (code) => process.exit(code ?? 1));
}
