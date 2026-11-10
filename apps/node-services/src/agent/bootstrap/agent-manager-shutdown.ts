interface Closeable {
  close(): Promise<void>;
}

export type ShutdownProgress = (
  phase: string,
  state: "started" | "completed" | "failed",
) => void;

export interface AgentManagerShutdownResources {
  server: Closeable & { drain(): Promise<void> };
  taskWorker: Closeable;
  wakeStream?: Closeable;
  runWakes?: { close(): void };
  /** Fails waiting model-call callers at once so HTTP drains. */
  modelCalls?: { close(): void };
  agentManager: Closeable;
  runtimeHosts: Closeable;
  runtimeStatusPublisher: Closeable;
  contextViewSessions: { close(): void };
  localMcpRelay?: Closeable;
}

// The process supervisor bounds the whole sequence. Never close a dependency
// while its owner is still stopping; a rejected stop still permits cleanup.
export const closeAgentManagerResources = async (
  resources: AgentManagerShutdownResources,
  progress?: ShutdownProgress,
): Promise<void> => {
  const failures: unknown[] = [];
  const phase = async (
    name: string,
    close: () => Promise<void>,
  ): Promise<void> => {
    progress?.(name, "started");
    try {
      await close();
      progress?.(name, "completed");
    } catch (error) {
      failures.push(error);
      progress?.(name, "failed");
    }
  };
  await Promise.all([
    phase("http-admission", () => resources.server.drain()),
    phase("task-worker", () => resources.taskWorker.close()),
    phase("wake-stream", async () => {
      await resources.wakeStream?.close();
    }),
    phase("run-wakes", async () => {
      resources.runWakes?.close();
    }),
    phase("model-calls", async () => {
      resources.modelCalls?.close();
    }),
    // close() synchronously rejects admission and requests the Run loops drain.
    // Do not let a slow HTTP handler or worker postpone stopping Run selection.
    phase("manager", () => resources.agentManager.close()),
  ]);
  await phase("runtime-hosts", () => resources.runtimeHosts.close());
  await phase("network", () => resources.server.close());
  await phase("runtime-status", () => resources.runtimeStatusPublisher.close());
  await phase("context-views", async () => {
    resources.contextViewSessions.close();
  });
  await phase("local-mcp-relay", async () => {
    await resources.localMcpRelay?.close();
  });
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Agent Manager shutdown failed");
};
