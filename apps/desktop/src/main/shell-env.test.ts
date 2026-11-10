import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loginShellEnvironment,
  runtimeSearchPath,
  withLoginShell,
  type RunShell,
} from "./shell-env.js";

const framed = (variables: Record<string, string>): string =>
  `banner\n__LINGER_ENV__${Object.entries(variables)
    .map(([key, value]) => `${key}=${value}\0`)
    .join("")}__LINGER_ENV__`;

describe.skipIf(process.platform === "win32")("loginShellEnvironment", () => {
  it("reads the interactive login shell's variables past its banner", async () => {
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const run: RunShell = async (_shell, args, options) => {
      calls.push({ args, env: options.env });
      return args[0] === "-ilc"
        ? {
            code: 0,
            stdout: framed({
              PATH: "/opt/homebrew/bin:/usr/bin",
              HTTPS_PROXY: "http://proxy:8080",
            }),
          }
        : { code: 0, stdout: framed({ PATH: "/usr/bin" }) };
    };
    const env = await loginShellEnvironment(
      {
        SHELL: "/bin/zsh",
        HOME: "/Users/me",
        PATH: "/usr/bin:/bin",
        SECRET: "x",
      },
      run,
    );
    expect(env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HTTPS_PROXY: "http://proxy:8080",
    });
    expect(calls.map((call) => call.args[0]).sort()).toEqual(["-ilc", "-lc"]);
    // The shell starts like a new terminal window, without the app's variables.
    expect(calls[0]!.env).toEqual({
      HOME: "/Users/me",
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
  });

  it("falls back to the non-interactive shell and gives up on failure", async () => {
    const fallback: RunShell = async (_shell, args) =>
      args[0] === "-ilc"
        ? { code: -1, stdout: "" }
        : { code: 0, stdout: framed({ PATH: "/usr/local/bin:/usr/bin" }) };
    expect(
      await loginShellEnvironment({ SHELL: "/bin/zsh" }, fallback),
    ).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
    });
    const failing: RunShell = async () => {
      throw new Error("spawn failed");
    };
    expect(
      await loginShellEnvironment({ SHELL: "/bin/zsh" }, failing),
    ).toBeUndefined();
    expect(
      await loginShellEnvironment({ SHELL: "zsh" }, fallback),
    ).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("withLoginShell", () => {
  it("puts the terminal PATH first and keeps the common install directories", () => {
    expect(
      runtimeSearchPath("/usr/bin:/bin", undefined, "/Users/me").split(
        path.delimiter,
      ),
    ).toEqual([
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/me/.local/bin",
      "/Users/me/.npm-global/bin",
      "/Users/me/.volta/bin",
      "/Users/me/.bun/bin",
      "/Users/me/.claude/local",
    ]);
    const env = withLoginShell(
      { PATH: "/usr/bin:/bin", HOME: "/Users/me", HTTPS_PROXY: "http://app:1" },
      {
        PATH: "/Users/me/.npm-global/bin:/usr/bin",
        HTTPS_PROXY: "http://shell:2",
        ANTHROPIC_BASE_URL: "https://llm.example",
        SHLVL: "2",
      },
      "/Users/me",
    );
    expect(env.PATH!.split(path.delimiter).slice(0, 4)).toEqual([
      "/Users/me/.npm-global/bin",
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
    ]);
    // What the app already has wins; shell bookkeeping stays out.
    expect(env.HTTPS_PROXY).toBe("http://app:1");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://llm.example");
    expect(env.SHLVL).toBeUndefined();
  });
  it("drops a parent Claude Code session and its host-managed provider", () => {
    const env = withLoginShell(
      {
        CLAUDECODE: "1",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
        CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_AUTH_TOKEN",
        CLAUDE_CODE_SESSION_ID: "session-1",
        CLAUDE_AGENT_SDK_VERSION: "1.0.0",
        ANTHROPIC_BASE_URL: "https://host-gateway.example",
        ANTHROPIC_AUTH_TOKEN: "host-token",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "host-model",
        CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
        HOME: "/Users/me",
        PATH: "/usr/bin:/bin",
      },
      {
        PATH: "/usr/bin",
        ANTHROPIC_BASE_URL: "https://user.example",
        ANTHROPIC_AUTH_TOKEN: "user-token",
      },
      "/Users/me",
    );
    expect(
      Object.keys(env).filter((key) =>
        /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/.test(key),
      ),
    ).toEqual([]);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://user.example");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("user-token");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/me/.claude-work");
    expect(env.HOME).toBe("/Users/me");
  });

  it("keeps the user's own provider settings from an ordinary terminal", () => {
    const env = withLoginShell(
      {
        PATH: "/usr/bin:/bin",
        ANTHROPIC_BASE_URL: "https://app.example",
        ANTHROPIC_API_KEY: "app-key",
      },
      { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://shell.example" },
      "/Users/me",
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("https://app.example");
    expect(env.ANTHROPIC_API_KEY).toBe("app-key");
  });

  it("leaves a Dock launch environment unchanged", () => {
    const app = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/Users/me",
      USER: "me",
    };
    const login = {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      ANTHROPIC_BASE_URL: "https://llm.example",
      HTTPS_PROXY: "http://proxy:1",
    };
    expect(withLoginShell(app, login, "/Users/me")).toEqual({
      ...app,
      ANTHROPIC_BASE_URL: "https://llm.example",
      HTTPS_PROXY: "http://proxy:1",
      PATH: runtimeSearchPath(app.PATH, login.PATH, "/Users/me"),
    });
  });
});
