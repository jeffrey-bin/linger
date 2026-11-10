import { usesBrowserOAuth } from "@linger/local-installation/runtime-login-mode";
import { stripVTControlCharacters } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import {
  inspectRuntime,
  type NativeRuntime,
} from "@linger/local-installation/managed-runtimes";
import { managedRuntimeEnvironment } from "@linger/local-installation/managed-codex";
import type { components } from "@linger/wire-contracts/linger-installer/types";
type Snapshot = components["schemas"]["RuntimeLogin"];
interface Input {
  instance: string;
  home: string;
  root: string;
  runtime: NativeRuntime;
}
interface Session {
  snapshot: Snapshot;
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
}
function allowedCodexUrl(url: URL, nativeBrowser: boolean) {
  if (url.hostname !== "auth.openai.com") return false;
  if (!nativeBrowser) return url.pathname === "/codex/device";
  if (url.pathname !== "/oauth/authorize") return false;
  try {
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    return (
      ["http://localhost:1455", "http://127.0.0.1:1455"].includes(
        callback.origin,
      ) &&
      callback.pathname === "/auth/callback" &&
      !callback.username &&
      !callback.password &&
      !callback.search &&
      !callback.hash
    );
  } catch {
    return false;
  }
}
/** Native output is private and ephemeral. Never attach it to persisted jobs or logs. */
export class RuntimeLoginManager {
  private sessions = new Map<string, Session>();
  constructor(
    private inspect: typeof inspectRuntime = inspectRuntime,
    private platform: NodeJS.Platform = process.platform,
  ) {}
  private async probe(input: Input) {
    const env = {
      ...process.env,
      ...(await managedRuntimeEnvironment(input.home, input.root)),
    };
    const state = await this.inspect(input.runtime, {
      home: input.home,
      env,
      signal: AbortSignal.timeout(15000),
    });
    return { env, state };
  }
  async status(input: Input): Promise<Snapshot> {
    const { state } = await this.probe(input);
    if (state.ready) {
      // The native CLI may write credentials before serving its final browser
      // callback. Let it exit naturally; killing it here races that response.
      return { state: "ready" };
    }
    return structuredClone(
      this.sessions.get(input.instance)?.snapshot ?? { state: "idle" },
    );
  }
  async start(input: Input, code?: string): Promise<Snapshot> {
    if (code !== undefined) {
      const session = this.sessions.get(input.instance);
      if (
        !session?.snapshot.acceptsCode ||
        !session.child.stdin?.writable ||
        !/^[A-Za-z0-9._~+/#=-]{1,4096}$/.test(code)
      )
        throw new Error("Invalid authorization code or inactive login");
      session.child.stdin.write(code + "\n");
      return structuredClone(session.snapshot);
    }
    const { env, state } = await this.probe(input);
    if (state.ready) return { state: "ready" };
    const existing = this.sessions.get(input.instance);
    if (
      existing &&
      ["starting", "waiting_user"].includes(existing.snapshot.state)
    )
      return structuredClone(existing.snapshot);
    this.stop(input.instance);
    if (!state.installed || input.runtime === "pi")
      return {
        state: "failed",
        message:
          "Native browser sign-in is unavailable for this runtime. You can sign in later.",
      };
    const descriptor =
      input.runtime === "codex" && !usesBrowserOAuth(this.platform)
        ? state.descriptor.deviceLoginCommand
        : state.descriptor.loginCommand;
    if (!descriptor)
      return {
        state: "failed",
        message:
          "The upstream Runtime does not offer browser sign-in. You can sign in later.",
      };
    const child = spawn(descriptor.executable, descriptor.args, {
      env: { ...env, ...descriptor.env },
      shell: false,
      detached: process.platform !== "win32",
      // Its output is read here; the browser opens on its own.
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: Session = {
      child,
      snapshot: { state: "starting" },
      timer: setTimeout(() => {
        this.stop(input.instance);
        session.snapshot = {
          state: "failed",
          message: "Sign-in timed out. Retry or sign in later.",
        };
        this.sessions.set(input.instance, session);
      }, 15 * 60_000),
    };
    session.timer.unref();
    this.sessions.set(input.instance, session);
    let output = "";
    const receive = (chunk: Buffer) => {
      output = stripVTControlCharacters(output + chunk.toString()).slice(
        -16384,
      );
      for (const match of output.matchAll(/https:\/\/[^\s<>"']+/g)) {
        try {
          const url = new URL(match[0]);
          const allowed =
            input.runtime === "codex"
              ? allowedCodexUrl(url, usesBrowserOAuth(this.platform))
              : (url.hostname === "claude.com" &&
                  url.pathname === "/cai/oauth/authorize") ||
                ([
                  "claude.ai",
                  "platform.claude.com",
                  "console.anthropic.com",
                ].includes(url.hostname) &&
                  url.pathname.startsWith("/oauth/"));
          if (!allowed || url.username || url.password || url.port) continue;
          session.snapshot = {
            ...session.snapshot,
            state: "waiting_user",
            url: url.href,
            acceptsCode: input.runtime === "claude",
          };
        } catch {
          /* Ignore non-vendor output; never return raw process text. */
        }
      }
      const deviceCode =
        input.runtime === "codex" && !usesBrowserOAuth(this.platform)
          ? output.match(/^\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\s*$/m)?.[1]
          : undefined;
      if (deviceCode) session.snapshot.deviceCode = deviceCode;
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    const failed = () => {
      session.snapshot = {
        state: "failed",
        message: "Native sign-in ended. Retry or sign in later.",
      };
    };
    child.once("error", failed);
    child.once("close", () => {
      clearTimeout(session.timer);
      output = "";
      void this.probe(input)
        .then(({ state }) => {
          session.snapshot = state.ready
            ? { state: "ready" }
            : {
                state: "failed",
                message: "Sign-in was not completed. Retry or sign in later.",
              };
        })
        .catch(failed);
    });
    return structuredClone(session.snapshot);
  }
  /** Stops a login this manager started, such as when the person cancels it. */
  cancel(instance: string): Snapshot {
    this.stop(instance);
    return { state: "idle" };
  }
  private stop(instance: string) {
    const session = this.sessions.get(instance);
    if (!session) return;
    clearTimeout(session.timer);
    if (session.child.exitCode === null && session.child.pid) {
      try {
        process.kill(
          process.platform === "win32" ? session.child.pid : -session.child.pid,
          "SIGTERM",
        );
      } catch {
        /* Owned login already exited. */
      }
    }
    this.sessions.delete(instance);
  }
  close() {
    for (const name of this.sessions.keys()) this.stop(name);
  }
}
