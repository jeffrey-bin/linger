import { EventEmitter } from "node:events";

import type { ConfigStore } from "./config.js";
import type { Logger } from "./log.js";

export type StopReason = "quit" | "update" | "logout";

export interface Module {
  readonly name: string;
  readonly dependsOn: readonly string[];
  start(ctx: ModuleContext): Promise<void>;
  stop(reason: StopReason): Promise<void>;
}

// In-process events between modules. Payloads never carry credentials.
export interface BusEvents {
  "computer.changed": [computerId: string | undefined];
  "computer.connection": [state: string];
  // Why the Computer service keeps exiting at start, or undefined once it ran.
  "computer.failed": [reason: string | undefined];
  "computer.renamed": [];
  "grants.changed": [];
  "local-server.changed": [];
  "local-server.retry": [];
  "power.changed": [];
  "runtime.activity": [running: number];
  "runtime.state": [state: string];
  "server.changed": [serverUrl: string];
  "status.changed": [status: { tone: string; label: string }];
  "update.changed": [state: string];
}

export class EventBus {
  readonly #emitter = new EventEmitter();

  emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): void {
    this.#emitter.emit(event, ...args);
  }

  on<K extends keyof BusEvents>(
    event: K,
    listener: (...args: BusEvents[K]) => void,
  ): () => void {
    this.#emitter.on(event, listener as (...args: unknown[]) => void);
    return () =>
      this.#emitter.off(event, listener as (...args: unknown[]) => void);
  }
}

export interface ModuleContext {
  readonly config: ConfigStore;
  readonly log: Logger;
  readonly bus: EventBus;
  get<T extends Module>(name: string): T;
}

const STOP_TIMEOUT_MS = 5_000;

// Groups modules into layers: every module starts after all of its
// dependencies, and modules in the same layer start in parallel.
export const startLayers = (
  modules: readonly Module[],
): readonly (readonly Module[])[] => {
  const byName = new Map(modules.map((m) => [m.name, m]));
  if (byName.size !== modules.length) throw new Error("Duplicate module name");
  for (const m of modules) {
    for (const dep of m.dependsOn) {
      if (!byName.has(dep))
        throw new Error(`${m.name} depends on unknown module ${dep}`);
    }
  }
  const layers: Module[][] = [];
  const placed = new Set<string>();
  while (placed.size < modules.length) {
    const layer = modules.filter(
      (m) => !placed.has(m.name) && m.dependsOn.every((d) => placed.has(d)),
    );
    if (layer.length === 0) {
      const rest = modules.filter((m) => !placed.has(m.name));
      throw new Error(
        `Module dependency cycle: ${rest.map((m) => m.name).join(", ")}`,
      );
    }
    for (const m of layer) placed.add(m.name);
    layers.push(layer);
  }
  return layers;
};

export class ModuleHost {
  readonly #layers: readonly (readonly Module[])[];
  readonly #byName: Map<string, Module>;
  readonly #started: Module[] = [];
  readonly #log: Logger;
  readonly ctx: ModuleContext;

  constructor(modules: readonly Module[], shared: Omit<ModuleContext, "get">) {
    this.#layers = startLayers(modules);
    this.#byName = new Map(modules.map((m) => [m.name, m]));
    this.#log = shared.log;
    this.ctx = {
      ...shared,
      get: <T extends Module>(name: string): T => {
        const m = this.#byName.get(name);
        if (!m) throw new Error(`Unknown module ${name}`);
        return m as T;
      },
    };
  }

  async start(): Promise<void> {
    for (const layer of this.#layers) {
      await Promise.all(
        layer.map(async (m) => {
          await m.start(this.ctx);
          this.#started.push(m);
          this.#log.info("module.started", { module: m.name });
        }),
      );
    }
  }

  // Reverse start order. A module that does not stop in time is abandoned so
  // quit and update are never blocked by one stuck module.
  async stop(reason: StopReason): Promise<void> {
    while (this.#started.length > 0) {
      const m = this.#started.pop()!;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), STOP_TIMEOUT_MS);
      });
      try {
        const outcome = await Promise.race([m.stop(reason), timeout]);
        if (outcome === "timeout")
          this.#log.warn("module.stop_timeout", { module: m.name });
      } catch (error) {
        this.#log.warn("module.stop_failed", {
          module: m.name,
          error: String(error),
        });
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
