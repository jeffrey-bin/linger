import type {
  ModelInvoke,
  ModelInvoked,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseAgentToDaemonEnvelope,
  RUNNER_GATEWAY_FRAME_LIMITS,
} from "@linger/wire-contracts/runner-gateway/validator";
import { LocalComputerOfflineError } from "./local-computer-management.js";
import type { ModelLease, ModelWork } from "./model-queue.js";
import type {
  RunnerGatewayContext,
  RunnerGatewayControllers,
} from "./runner-gateway-context.js";
import {
  RunnerGatewayError,
  RunnerGatewayProtocolError,
} from "./runner-operation.js";

/** Instructions plus input, in UTF-8 bytes; leaves room in the 4 MiB frame. */
export const MODEL_INVOKE_MAX_PROMPT_BYTES = 3 * 1024 * 1024;

/**
 * How long a sent call keeps its place past its own timeout when no executed
 * model_invoke reply arrives, so a lost reply cannot hold a place forever.
 */
const MODEL_INVOKE_REPLY_GRACE_MS = 30_000;

export interface RunnerModelInvokeRequest {
  readonly tenantId: string;
  readonly ownerActorId: string;
  /** The owner's Agent on this Computer; the Daemon refuses it when locally stopped. */
  readonly agentId: string;
  readonly runtimeType: ModelInvoke["runtime_type"];
  readonly mode: ModelInvoke["mode"];
  readonly reasoningEffort: ModelInvoke["reasoning_effort"];
  readonly instructions?: string;
  readonly input: string;
  readonly outputSchema?: ModelInvoke["output_schema"];
  readonly workspaceFiles?: ModelInvoke["workspace_files"];
  readonly sessionKey?: ModelInvoke["session_key"];
  readonly timeoutMs: number;
  readonly maxOutputChars?: ModelInvoke["max_output_chars"];
  /** The call's place in its endpoint's queue; absent, it runs at once: a
   * chain's call runs in its chain's place, and some kinds never queue. */
  readonly queue?: ModelWork & {
    /** The Run Operation an approval reviews. While that Operation holds its
     * place on the same endpoint, the approval runs in it: the Run waits for
     * the verdict, so queuing behind it would never end. */
    readonly runOperationId?: string;
  };
  /** Aborting stops waiting, including in the queue; the Daemon is not told. */
  readonly signal: AbortSignal;
}

export type RunnerModelInvokeOutcome = Omit<
  ModelInvoked,
  "type" | "kind" | "command_id" | "runner_id" | "invoke_id"
>;

/**
 * The Computer is connected but cannot run this call: the Runtime is not
 * ready there. Signing the Runtime in fixes it.
 */
export class RunnerModelInvokeUnavailableError extends RunnerGatewayError {
  constructor(message: string) {
    super(message);
    this.name = "RunnerModelInvokeUnavailableError";
  }
}

interface InFlightCall {
  readonly runnerId: string;
  readonly lease?: ModelLease;
  readonly timer: NodeJS.Timeout;
  waiter?: {
    readonly signal: AbortSignal;
    readonly onAbort: () => void;
    resolve(outcome: RunnerModelInvokeOutcome): void;
    reject(error: unknown): void;
  };
}

export class RunnerModelInvocation {
  // Keyed by invoke id. A call keeps its place until its reply, a disconnect
  // or the reply grace ends, even after its caller stopped waiting.
  readonly #inFlight = new Map<string, InFlightCall>();

  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<
      RunnerGatewayControllers,
      "connections" | "operations" | "queue"
    >,
  ) {}

  /**
   * Runs one model call on the Computer's Runtime once the model queue
   * admits it, independently of the Operation capacity.
   */
  async invokeModel(
    computerId: string,
    request: RunnerModelInvokeRequest,
  ): Promise<RunnerModelInvokeOutcome> {
    request.signal.throwIfAborted();
    const promptBytes =
      Buffer.byteLength(request.instructions ?? "", "utf8") +
      Buffer.byteLength(request.input, "utf8");
    if (promptBytes > MODEL_INVOKE_MAX_PROMPT_BYTES) {
      throw new RangeError("Model invocation prompt exceeds 3 MiB");
    }
    this.#assertAvailable(computerId, request.runtimeType);
    const endpoint = { computerId, runtimeType: request.runtimeType };
    const { queue } = request;
    const lease =
      !queue ||
      this.owners.operations().holdsModelPlace(queue.runOperationId, endpoint)
        ? undefined
        : await this.owners.queue().acquire(endpoint, queue, request.signal);
    let sent = false;
    try {
      const connections = this.owners.connections();
      const connection = connections.getConnection(computerId);
      this.#assertAvailable(computerId, request.runtimeType);
      if (!connection) throw new LocalComputerOfflineError();
      const command = this.#command(
        computerId,
        connection.connectionEpoch,
        request,
      );
      const outcome = this.#wait(command, request, lease);
      sent = true;
      try {
        await connections.sendToCurrentRunner(command);
      } catch {
        this.#finish(command.invoke_id, {
          error: new LocalComputerOfflineError(),
        });
      }
      return await outcome;
    } finally {
      if (!sent) lease?.release({ outcome: "not_sent" });
    }
  }

  /** Advisory: a reply nobody waits for only frees its place. */
  receiveModelInvoked(runnerId: string, envelope: ModelInvoked): void {
    const call = this.#inFlight.get(envelope.invoke_id);
    if (call?.runnerId !== runnerId) return;
    const {
      type: _type,
      kind: _kind,
      command_id: _commandId,
      runner_id: _runnerId,
      invoke_id: _invokeId,
      ...outcome
    } = envelope;
    this.#finish(envelope.invoke_id, { outcome });
  }

  rejectWaitersForComputer(runnerId: string): void {
    for (const [invokeId, call] of this.#inFlight) {
      if (call.runnerId !== runnerId) continue;
      this.#finish(invokeId, { error: new LocalComputerOfflineError() });
    }
    this.owners
      .queue()
      .rejectWaiters(runnerId, new LocalComputerOfflineError());
  }

  #assertAvailable(
    computerId: string,
    runtimeType: RunnerModelInvokeRequest["runtimeType"],
  ): void {
    const connections = this.owners.connections();
    if (!connections.isLocalComputerExecutionReady(computerId)) {
      throw new LocalComputerOfflineError();
    }
    if (!connections.supportsModelInvoke(computerId, runtimeType)) {
      throw new RunnerModelInvokeUnavailableError(
        `Local Computer Runtime ${runtimeType} is not ready`,
      );
    }
  }

  #command(
    computerId: string,
    connectionEpoch: number,
    request: RunnerModelInvokeRequest,
  ): ModelInvoke {
    const command = parseAgentToDaemonEnvelope({
      type: "execute",
      kind: "model_invoke",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: this.context.createId(),
      invoke_id: this.context.createId(),
      runner_id: computerId,
      connection_epoch: connectionEpoch,
      tenant_id: request.tenantId,
      owner_actor_id: request.ownerActorId,
      agent_id: request.agentId,
      runtime_type: request.runtimeType,
      mode: request.mode,
      reasoning_effort: request.reasoningEffort,
      ...(request.instructions ? { instructions: request.instructions } : {}),
      input: request.input,
      ...(request.outputSchema ? { output_schema: request.outputSchema } : {}),
      ...(request.workspaceFiles
        ? { workspace_files: request.workspaceFiles }
        : {}),
      ...(request.sessionKey ? { session_key: request.sessionKey } : {}),
      timeout_ms: request.timeoutMs,
      ...(request.maxOutputChars === undefined
        ? {}
        : { max_output_chars: request.maxOutputChars }),
    });
    if (command.type !== "execute" || command.kind !== "model_invoke") {
      throw new RunnerGatewayProtocolError("Invalid model invocation command");
    }
    // The Daemon drops the connection on a frame over its read limit.
    if (
      Buffer.byteLength(JSON.stringify(command), "utf8") >
      RUNNER_GATEWAY_FRAME_LIMITS.maxBytes
    ) {
      throw new RangeError("Model invocation exceeds the Runner frame limit");
    }
    return command;
  }

  #wait(
    command: ModelInvoke,
    request: RunnerModelInvokeRequest,
    lease: ModelLease | undefined,
  ): Promise<RunnerModelInvokeOutcome> {
    return new Promise<RunnerModelInvokeOutcome>((resolve, reject) => {
      const { signal } = request;
      const timer = setTimeout(
        () =>
          this.#finish(command.invoke_id, {
            error: new RunnerGatewayError(
              "Local Computer did not answer the model invocation",
            ),
          }),
        command.timeout_ms + MODEL_INVOKE_REPLY_GRACE_MS,
      );
      timer.unref();
      const onAbort = () => {
        const call = this.#inFlight.get(command.invoke_id);
        if (!call?.waiter) return;
        call.waiter = undefined;
        reject(signal.reason ?? new Error("Model invocation was abandoned"));
      };
      this.#inFlight.set(command.invoke_id, {
        runnerId: command.runner_id,
        ...(lease ? { lease } : {}),
        timer,
        waiter: { signal, onAbort, resolve, reject },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  #finish(
    invokeId: string,
    result:
      | { readonly outcome: RunnerModelInvokeOutcome }
      | { readonly error: unknown },
  ): void {
    const call = this.#inFlight.get(invokeId);
    if (!call) return;
    this.#inFlight.delete(invokeId);
    clearTimeout(call.timer);
    call.lease?.release(
      "outcome" in result
        ? {
            outcome: result.outcome.outcome,
            ...(result.outcome.usage ? { usage: result.outcome.usage } : {}),
          }
        : { outcome: "lost" },
    );
    const waiter = call.waiter;
    if (!waiter) return;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    if ("outcome" in result) waiter.resolve(result.outcome);
    else waiter.reject(result.error);
  }
}
