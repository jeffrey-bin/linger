import type {
  SessionCompact,
  SessionCompacted,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseAgentToDaemonEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
import { COMPACTION_PRIORITY } from "../../model-tasks.js";
import { LocalComputerOfflineError } from "./local-computer-management.js";
import type { ModelLease } from "./model-queue.js";
import type {
  RunnerGatewayContext,
  RunnerGatewayControllers,
} from "./runner-gateway-context.js";
import {
  RunnerGatewayProtocolError,
  type RunnerSessionCompactOptions,
  type RunnerSessionCompactOutcome,
  type RunnerSessionCompactTarget,
} from "./runner-operation.js";

interface SessionCompactionWaiter {
  readonly command: SessionCompact;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  resolve(outcome: SessionCompacted): void;
  reject(error: unknown): void;
}

export class RunnerSessionCompaction {
  // Keyed by compact id. Only the caller's signal bounds a wait: compaction
  // runs as long as the Runtime needs, and the caller sets the deadline.
  readonly #waiters = new Map<string, SessionCompactionWaiter>();

  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<
      RunnerGatewayControllers,
      "connections" | "lifecycle" | "queue"
    >,
  ) {}

  /**
   * Asks the Daemon to compact the process it keeps parked for this Context,
   * once the model queue admits it. The Daemon never starts a process for
   * it, and it interrupts the compaction itself when the Context's next work
   * arrives, so aborting the signal only stops waiting and sends nothing.
   */
  async compactParkedSession(
    target: RunnerSessionCompactTarget,
    options: RunnerSessionCompactOptions,
  ): Promise<RunnerSessionCompactOutcome> {
    options.signal.throwIfAborted();
    const unavailable = {
      outcome: "no_process",
      reason: "computer_unavailable",
    } as const;
    if (!this.#available(target, options)) return unavailable;
    let lease: ModelLease;
    try {
      lease = await this.owners.queue().acquire(
        { computerId: target.runnerId, runtimeType: options.runtimeType },
        {
          priority: COMPACTION_PRIORITY,
          kind: "compaction",
          key: target.executionContextKey,
        },
        options.signal,
      );
    } catch (error) {
      if (error instanceof LocalComputerOfflineError) return unavailable;
      throw error;
    }
    let outcome = "not_sent";
    try {
      if (!this.#available(target, options)) return unavailable;
      const compacted = await this.#compact(target, options);
      outcome = compacted.outcome;
      return compacted;
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      lease.release({ outcome });
    }
  }

  #available(
    target: RunnerSessionCompactTarget,
    options: RunnerSessionCompactOptions,
  ): boolean {
    const connections = this.owners.connections();
    return (
      connections.getConnection(target.runnerId) !== undefined &&
      connections.supportsSessionCompaction(
        target.runnerId,
        options.runtimeType,
      )
    );
  }

  async #compact(
    target: RunnerSessionCompactTarget,
    options: RunnerSessionCompactOptions,
  ): Promise<SessionCompacted> {
    const connections = this.owners.connections();
    const connection = connections.getConnection(target.runnerId)!;
    const command = parseAgentToDaemonEnvelope({
      type: "execute",
      kind: "session_compact",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: this.context.createId(),
      compact_id: this.context.createId(),
      runner_id: target.runnerId,
      connection_epoch: connection.connectionEpoch,
      agent_id: target.agentId,
      runtime_type: options.runtimeType,
      execution_context_key: target.executionContextKey,
      ...(options.instructions ? { instructions: options.instructions } : {}),
    });
    if (command.type !== "execute" || command.kind !== "session_compact") {
      throw new RunnerGatewayProtocolError(
        "Invalid session compaction command",
      );
    }
    const outcome = this.#wait(command, options.signal);
    try {
      await connections.sendToCurrentRunner(command);
    } catch (error) {
      this.#finish(command.compact_id, { error });
    }
    return outcome;
  }

  /**
   * Advisory like a prepared provider outcome: an outcome nobody waits for, such as one
   * for an abandoned wait or from an earlier connection, is ignored.
   */
  receiveSessionCompacted(runnerId: string, envelope: SessionCompacted): void {
    const waiter = this.#waiters.get(envelope.compact_id);
    if (waiter?.command.runner_id !== runnerId) return;
    if (
      envelope.execution_context_key !== waiter.command.execution_context_key
    ) {
      this.#finish(envelope.compact_id, {
        error: new RunnerGatewayProtocolError(
          "Session compaction outcome identity mismatch",
        ),
      });
      return;
    }
    this.#finish(envelope.compact_id, { outcome: envelope });
  }

  rejectWaitersForComputer(runnerId: string): void {
    for (const [compactId, waiter] of this.#waiters) {
      if (waiter.command.runner_id !== runnerId) continue;
      this.#finish(compactId, { error: new LocalComputerOfflineError() });
    }
  }

  #wait(
    command: SessionCompact,
    signal: AbortSignal,
  ): Promise<SessionCompacted> {
    return new Promise<SessionCompacted>((resolve, reject) => {
      const onAbort = () =>
        this.#finish(command.compact_id, {
          error: signal.reason ?? new Error("Session compaction was abandoned"),
        });
      this.#waiters.set(command.compact_id, {
        command,
        signal,
        onAbort,
        resolve,
        reject,
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  #finish(
    compactId: string,
    result:
      | { readonly outcome: SessionCompacted }
      | { readonly error: unknown },
  ): void {
    const waiter = this.#waiters.get(compactId);
    if (!waiter) return;
    this.#waiters.delete(compactId);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    if ("outcome" in result) waiter.resolve(result.outcome);
    else waiter.reject(result.error);
  }
}
