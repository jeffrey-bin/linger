import type { AgentContextHost } from "../../executor/workspace.js";
import type { ModelCall } from "../../../runtime-model-call.js";
import type { AgentLogger } from "../../observability/agent-log.js";
import type { TeamHubRuntimeStateClient } from "../../executor/teamhub-runtime-state-client.js";
import type { MemoryClient } from "./client.js";
import { AgentMemoryCoordinator, type AgentMemoryHost } from "./coordinator.js";
import type { AgentMemoryFeatureDeps } from "./feature.js";
import { createMemoryProjection } from "./projection.js";

/** Stateless model calls that extract and consolidate memory. */
export interface AgentMemoryMaintenance {
  readonly modelCall: ModelCall;
}

/**
 * Assembly inputs for the shared Agent Memory services. Everything here is
 * available before the AgentManager exists; the host itself is bound by
 * start().
 */
export interface AgentMemoryServicesOptions {
  readonly memory: MemoryClient;
  readonly contextHost: Pick<AgentContextHost, "ensureAgentRoots">;
  readonly runtimeState: TeamHubRuntimeStateClient;
  readonly logger: Pick<AgentLogger, "log">;
  /**
   * Maintenance is off when absent: published memory is still projected, but
   * nothing new is extracted.
   */
  readonly maintenance?: AgentMemoryMaintenance;
  /**
   * Whether a Local Computer is online and can serve this Runtime's history
   * now. Maintenance never wakes or waits for a Computer.
   */
  readonly canReadHistory?: (
    computerId: string,
    runtimeType: "codex" | "claude" | "pi",
  ) => boolean;
  readonly now?: () => number;
}

/**
 * Explicit assembly surface for the shared Agent Memory services: the
 * maintenance Coordinator plus the activation-scoped projection.
 * `featureDeps` stays stable before `start()` so the feature can be declared
 * while the host (AgentManager) is still being assembled; `start(host)` binds
 * that late host and begins shared maintenance exactly once. Lifecycle is
 * `idle → started → closed` or `idle → closed`: a wake before `start()` fails
 * loudly so a missed assembly call is never hidden, and `start()` after
 * `close()` is rejected so no unmanaged timer can be left behind.
 */
export interface AgentMemoryServices {
  /** Narrow deps for createAgentMemoryFeature; safe to bind immediately. */
  readonly featureDeps: AgentMemoryFeatureDeps;
  /** Bind the host and begin shared maintenance; throws on a second call. */
  start(host: AgentMemoryHost): void;
  /** Stop shared maintenance and drain in-flight work; concurrent calls share one completion. */
  close(): Promise<void>;
}

export const createAgentMemoryServices = (
  options: AgentMemoryServicesOptions,
): AgentMemoryServices => {
  const projection = createMemoryProjection(
    options.memory,
    options.contextHost,
  );
  let coordinator: AgentMemoryCoordinator | undefined;
  let started = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  const withCoordinator = (
    action: (maintenance: AgentMemoryCoordinator) => Promise<void>,
  ): Promise<void> => {
    if (!started) {
      // After close the bound Context can still observe a terminal;
      // keep the coordinator's stopped wake semantics (quiet resolve).
      if (closed) return Promise.resolve();
      throw new Error("agent memory services not started");
    }
    return coordinator ? action(coordinator) : Promise.resolve();
  };
  return {
    featureDeps: {
      agentMemory: {
        recordRun: (agentId) =>
          withCoordinator((maintenance) => maintenance.recordRun(agentId)),
        wake: (agentId) =>
          withCoordinator((maintenance) => maintenance.wake(agentId)),
      },
      agentMemoryProjection: projection,
    },
    start(host) {
      if (closed) throw new Error("agent memory services are closed");
      if (started) throw new Error("agent memory services already started");
      started = true;
      if (!options.maintenance) {
        options.logger.log("info", "agent_memory.maintenance_unavailable", {
          reason: "LLM gateway is not configured",
        });
        return;
      }
      coordinator = new AgentMemoryCoordinator({
        host,
        runtimeState: options.runtimeState,
        memory: options.memory,
        modelCall: options.maintenance.modelCall,
        logger: options.logger,
        ...(options.canReadHistory
          ? { canReadHistory: options.canReadHistory }
          : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    },
    close: () =>
      (closePromise ??= (async () => {
        closed = true;
        await coordinator?.close();
      })()),
  };
};
