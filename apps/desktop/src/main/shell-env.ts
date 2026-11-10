import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

// The daemon and the runtimes it starts need the environment the user's
// terminal has. An app opened from Finder or the Dock only gets
// PATH=/usr/bin:/bin:/usr/sbin:/sbin and none of the shell profile's settings.

const LOGIN_SHELL_TIMEOUT_MS = 10_000;
const TERMINAL_VARIABLES = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
] as const;
const ENV_MARKER = "__LINGER_ENV__";
// Shell bookkeeping, not settings; PATH is merged by runtimeSearchPath.
const SHELL_ONLY_VARIABLES = new Set(["PATH", "PWD", "OLDPWD", "SHLVL", "_"]);

// Where package managers and installers usually put the Codex and Claude
// CLIs, searched even when the login shell lookup fails.
const COMMON_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "~/.local/bin",
  "~/.npm-global/bin",
  "~/.volta/bin",
  "~/.bun/bin",
  "~/.claude/local",
];

export type RunShell = (
  shell: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly env: NodeJS.ProcessEnv },
) => Promise<{ readonly code: number; readonly stdout: string }>;

const runShell: RunShell = (shell, args, options) =>
  new Promise((resolve) => {
    execFile(
      shell,
      args,
      { timeout: options.timeoutMs, env: options.env, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        resolve({ code: error ? -1 : 0, stdout: String(stdout) });
      },
    );
  });

const userShell = (): string | undefined => {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
};

// The environment as the user's terminal sees it: PATH, API keys, proxy and CA
// certificate settings from the shell profile. Interactive so that version
// managers set up in .zshrc / .bashrc (nvm, volta) are included; markers keep
// any banner the shell prints out of the result.
export const loginShellEnvironment = async (
  env: NodeJS.ProcessEnv = process.env,
  run: RunShell = runShell,
): Promise<Record<string, string> | undefined> => {
  if (process.platform === "win32") return undefined;
  // Without SHELL (e.g. a stripped child environment) use the account shell.
  const shell = (env.SHELL ?? userShell())?.trim();
  if (!shell || !path.isAbsolute(shell)) return undefined;
  const script = `printf '${ENV_MARKER}'; /usr/bin/env -0; printf '${ENV_MARKER}'`;
  // Start from what a new terminal window gets, so the shell's own PATH order
  // wins over the app's inherited one.
  const terminalEnv = {
    ...Object.fromEntries(
      TERMINAL_VARIABLES.flatMap((key) =>
        env[key] === undefined ? [] : [[key, env[key]]],
      ),
    ),
    SHELL: shell,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  // Both shells start together and the interactive one wins when it works,
  // so a hanging .zshrc costs one timeout instead of two.
  const results = await Promise.all(
    ["-ilc", "-lc"].map((flags) =>
      run(shell, [flags, script], {
        timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
        env: terminalEnv,
      }).catch(() => ({ code: -1, stdout: "" })),
    ),
  );
  for (const { code, stdout } of results) {
    const match = new RegExp(`${ENV_MARKER}(.*?)${ENV_MARKER}`, "s").exec(
      stdout,
    );
    const variables = code === 0 ? parseEnv(match?.[1] ?? "") : {};
    if (variables.PATH) return variables;
  }
  return undefined;
};

const parseEnv = (text: string): Record<string, string> => {
  const variables: Record<string, string> = {};
  for (const entry of text.split("\0")) {
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator);
    if (separator > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      variables[key] = entry.slice(separator + 1);
  }
  return variables;
};

// The login shell's PATH first, so `codex` and `claude` resolve to the same
// executables as in the user's terminal, then the inherited PATH, then the
// common install directories.
export const runtimeSearchPath = (
  current: string | undefined,
  login: string | undefined,
  home = os.homedir(),
): string => {
  const directories = [
    ...(login ?? "").split(path.delimiter),
    ...(current ?? "").split(path.delimiter),
    ...(process.platform === "win32"
      ? []
      : COMMON_DIRECTORIES.map((directory) =>
          directory.startsWith("~/")
            ? path.join(home, directory.slice(2))
            : directory,
        )),
  ].filter((directory) => directory && path.isAbsolute(directory));
  return [...new Set(directories)].join(path.delimiter);
};

// An app opened from an agent session's terminal (e.g. `open -a` inside
// Claude Code) inherits that session's identity and, when the host manages
// the provider, its gateway URL, token and model ids, which are invalid
// outside the host. A Dock or Finder launch has none of them.
const withoutParentAgentSession = (
  env: Readonly<Record<string, string>>,
): Record<string, string> => {
  const hostManagedProvider = Boolean(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST);
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/i.test(key) &&
        !(hostManagedProvider && /^ANTHROPIC_/i.test(key)),
    ),
  );
};

// The app's environment, without a parent agent session's variables, plus the
// terminal's PATH and the shell variables the app was not started with. What
// the app already has wins.
export const withLoginShell = (
  env: Readonly<Record<string, string>>,
  login: Readonly<Record<string, string>> | undefined,
  home = os.homedir(),
): Record<string, string> => {
  const merged = withoutParentAgentSession(env);
  for (const [key, value] of Object.entries(login ?? {}))
    if (merged[key] === undefined && !SHELL_ONLY_VARIABLES.has(key))
      merged[key] = value;
  merged.PATH = runtimeSearchPath(env.PATH, login?.PATH, home);
  return merged;
};
