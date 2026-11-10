import type { Module, ModuleContext } from "./modules.js";

// Electron's powerSaveBlocker and powerMonitor, injected for tests.
export interface PowerApi {
  block(): number;
  unblock(id: number): void;
  onPowerEvent(listener: (kind: "suspend" | "resume") => void): () => void;
}

// Keeps the system awake while operations run or in always-on mode.
// The daemon reconnects by itself after a resume.
export class PowerGuardModule implements Module {
  readonly name = "PowerGuard";
  readonly dependsOn = ["ComputerDaemon"];
  readonly #power: PowerApi;
  #ctx: ModuleContext | undefined;
  #running = 0;
  #blocker: number | undefined;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(power: PowerApi) {
    this.#power = power;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    this.#unsubscribe.push(
      ctx.bus.on("runtime.activity", (running) => {
        this.#running = running;
        this.#apply();
      }),
      this.#power.onPowerEvent((kind) => {
        ctx.log.info("power.event", { kind });
      }),
    );
    this.#apply();
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#release();
  }

  alwaysOn(): boolean {
    return this.#ctx!.config.get().preventSleep;
  }

  setAlwaysOn(on: boolean): void {
    this.#ctx!.config.update({ preventSleep: on });
    this.#apply();
  }

  active(): boolean {
    return this.#blocker !== undefined;
  }

  #apply(): void {
    const want = this.alwaysOn() || this.#running > 0;
    if (want && this.#blocker === undefined) {
      this.#blocker = this.#power.block();
      this.#ctx!.log.info("power.blocking", { running: this.#running });
    } else if (!want) {
      this.#release();
    }
    this.#ctx!.bus.emit("power.changed");
  }

  #release(): void {
    if (this.#blocker === undefined) return;
    this.#power.unblock(this.#blocker);
    this.#blocker = undefined;
    this.#ctx?.log.info("power.released");
  }
}
