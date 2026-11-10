import { access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runProcess } from "./process.js";

// What a command prints when it needed a C toolchain a Mac does not have:
// node-gyp falling back from a prebuilt binary, or one of Apple's tool shims.
const TOOLCHAIN_FAILURE =
  /gyp ERR!|xcrun: error|CommandLineTools|xcode-select|developer tools/i;

const INSTALLER = "Install Command Line Developer Tools";

export interface AppleDeveloperToolsOptions {
  signal: AbortSignal;
  platform?: NodeJS.Platform;
  run?: typeof runProcess;
}

// Whether the active developer directory has the tools a compiler needs.
// xcode-select itself never opens Apple's installer, unlike cc or xcrun.
export async function appleDeveloperToolsReady(
  options: AppleDeveloperToolsOptions,
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") return true;
  const run = options.run ?? runProcess;
  const result = await run("/usr/bin/xcode-select", ["-p"], {
    signal: options.signal,
  }).catch(() => undefined);
  const directory = result?.code === 0 ? result.stdout.trim() : "";
  if (!directory) return false;
  // It can still name a directory an uninstall removed. The Command Line
  // Tools carry clang there; Xcode keeps it in a toolchain beside xcodebuild.
  for (const tool of ["usr/bin/clang", "usr/bin/xcodebuild"])
    if (
      await access(path.join(directory, tool)).then(
        () => true,
        () => false,
      )
    )
      return true;
  return false;
}

// Whether a command failed because this Mac lacks Apple's developer tools.
export async function needsAppleDeveloperTools(
  output: string,
  options: AppleDeveloperToolsOptions,
): Promise<boolean> {
  return (
    (options.platform ?? process.platform) === "darwin" &&
    TOOLCHAIN_FAILURE.test(output) &&
    !(await appleDeveloperToolsReady(options))
  );
}

// Opens Apple's installer for the Command Line Tools and resolves once they
// are in place. The person confirms the install in Apple's window.
export async function installAppleDeveloperTools(
  options: AppleDeveloperToolsOptions & {
    onWaiting: (seconds: number) => void;
    pollMs?: number;
    timeoutMs?: number;
  },
): Promise<void> {
  const run = options.run ?? runProcess;
  const pollMs = options.pollMs ?? 5_000;
  const startedAt = Date.now();
  // It exits non-zero when Apple's window is already open; that is fine.
  await run("/usr/bin/xcode-select", ["--install"], {
    signal: options.signal,
  }).catch(() => undefined);
  let seen = false;
  for (;;) {
    await delay(pollMs, undefined, { signal: options.signal });
    if (await appleDeveloperToolsReady(options)) return;
    const open =
      (
        await run("/usr/bin/pgrep", ["-f", INSTALLER], {
          signal: options.signal,
        }).catch(() => undefined)
      )?.code === 0;
    seen ||= open;
    const elapsed = Date.now() - startedAt;
    // Apple's window takes a moment to appear; once it has gone without
    // installing anything, the person cancelled it.
    if ((seen || elapsed > 60_000) && !open)
      throw new Error(
        "Apple's developer tools were not installed. Retry and choose Install in the window macOS opens.",
      );
    if (elapsed > (options.timeoutMs ?? 60 * 60_000))
      throw new Error(
        "Apple's developer tools are still not installed. Finish the install in the window macOS opened, then retry.",
      );
    options.onWaiting(Math.floor(elapsed / 1000));
  }
}
