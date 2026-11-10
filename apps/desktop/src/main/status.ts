import type { RuntimeState } from "../shared/api.js";
import type { ComputerDaemonModule } from "./computer-daemon.js";
import type { Module, ModuleContext } from "./modules.js";

export type StatusTone = "online" | "busy" | "offline" | "error" | "setup";

export interface StatusInput {
  // ComputerDaemonModule.connection().
  readonly connection: string;
  readonly runtime: RuntimeState;
  readonly enrolled: boolean;
  readonly running: number;
}

export interface StatusSummary {
  readonly tone: StatusTone;
  readonly label: string;
}

// One line shown at the top of the tray menu.
export const summarizeStatus = (input: StatusInput): StatusSummary => {
  if (!input.enrolled) return { tone: "setup", label: "Not Connected" };
  switch (input.connection) {
    case "auth_failed":
      return {
        tone: "error",
        label: "Sign-in Expired · Reconnect This Computer",
      };
    case "upgrade_required":
      return { tone: "error", label: "Update Required" };
  }
  if (input.runtime === "crashed")
    return { tone: "error", label: "Runtime Error · Restarting" };
  if (input.runtime !== "ready") return { tone: "offline", label: "Starting…" };
  if (input.connection !== "online")
    return { tone: "offline", label: "Offline · Reconnecting" };
  if (input.running > 0)
    return {
      tone: "busy",
      label: `Running ${input.running} ${input.running === 1 ? "Task" : "Tasks"}`,
    };
  return { tone: "online", label: "Online · Idle" };
};

// Recomputes the summary from module state and announces changes.
export class StatusModule implements Module {
  readonly name = "Status";
  readonly dependsOn = ["ComputerDaemon"];
  #ctx: ModuleContext | undefined;
  #current: StatusSummary = { tone: "offline", label: "Starting…" };
  readonly #unsubscribe: (() => void)[] = [];

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    const update = (): void => this.#update();
    this.#unsubscribe.push(
      ctx.bus.on("computer.connection", update),
      ctx.bus.on("runtime.state", update),
      ctx.bus.on("runtime.activity", update),
      ctx.bus.on("computer.changed", update),
    );
    this.#update();
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
  }

  current(): StatusSummary {
    return this.#current;
  }

  #update(): void {
    const ctx = this.#ctx!;
    const daemon = ctx.get<ComputerDaemonModule>("ComputerDaemon");
    const next = summarizeStatus({
      connection: daemon.connection(),
      runtime: daemon.state(),
      enrolled: !!ctx.config.get().computerId,
      running: daemon.running(),
    });
    if (next.tone === this.#current.tone && next.label === this.#current.label)
      return;
    this.#current = next;
    ctx.bus.emit("status.changed", next);
  }
}
