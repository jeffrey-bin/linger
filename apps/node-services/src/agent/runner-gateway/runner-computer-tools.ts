import type {
  ComputerToolResult,
  SharedTaskScope,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseAgentToDaemonEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
import type {
  ConnectedRunner,
  RunnerGatewayContext,
  RunnerGatewayControllers,
} from "./runner-gateway-context.js";
import { isServingConnection } from "./runner-connections.js";
import {
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
} from "./local-computer-management.js";

export interface ComputerToolRequest {
  tenantId: string;
  ownerActorId: string;
  computerId: string;
  agentId: string;
  toolSessionId: string;
  server: "browser" | "task_files";
  toolName: string;
  arguments: Record<string, unknown>;
  taskScope?: SharedTaskScope;
  signal: AbortSignal;
}
const unknown = () => ({
  status: "outcome_unknown",
  detail:
    "The Computer may have executed the operation. Verify its effect before retrying.",
});

/** A typed product capability. It never opens a Meta or another model turn. */
export class RunnerComputerTools {
  private readonly pending = new Map<
    string,
    {
      connection: ConnectedRunner;
      agentId: string;
      tenantId: string;
      ownerActorId: string;
      resolve: (result: Record<string, unknown>) => void;
    }
  >();
  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<
      RunnerGatewayControllers,
      "connections" | "lifecycle"
    >,
  ) {}
  async call(request: ComputerToolRequest): Promise<Record<string, unknown>> {
    request.signal.throwIfAborted();
    const connection = this.owners
      .connections()
      .getConnection(request.computerId);
    if (!isServingConnection(connection)) throw new LocalComputerOfflineError();
    if (connection.tenantOwners.get(request.tenantId) !== request.ownerActorId)
      throw new LocalComputerNotFoundError();
    if (
      !this.owners
        .lifecycle()
        .places(request.computerId, request.tenantId, request.agentId)
    )
      throw new LocalComputerNotFoundError();
    if (
      request.taskScope &&
      (request.server !== "task_files" ||
        request.taskScope.tenant_id !== request.tenantId ||
        request.taskScope.agent_id !== request.agentId ||
        request.taskScope.role !== "alter_ego")
    )
      throw new LocalComputerNotFoundError();
    if (this.pending.size >= 16) return { status: "busy" };
    const commandId = this.context.createId();
    const command = parseAgentToDaemonEnvelope({
      type: "execute",
      kind: "computer_tool",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: commandId,
      runner_id: request.computerId,
      connection_epoch: connection.connectionEpoch,
      tenant_id: request.tenantId,
      owner_actor_id: request.ownerActorId,
      agent_id: request.agentId,
      tool_session_id: request.toolSessionId,
      server: request.server,
      tool_name: request.toolName,
      arguments: request.arguments,
      ...(request.taskScope ? { task_scope: request.taskScope } : {}),
      deadline_ms: 60_000,
    });
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = new Promise<Record<string, unknown>>((resolve) => {
        this.pending.set(commandId, {
          connection,
          agentId: request.agentId,
          tenantId: request.tenantId,
          ownerActorId: request.ownerActorId,
          resolve,
        });
        abort = () => resolve(unknown());
        request.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => resolve(unknown()), 62_000);
        timer.unref();
      });
      request.signal.throwIfAborted();
      await this.owners.connections().sendToCurrentRunner(command);
      return await result;
    } catch {
      return unknown();
    } finally {
      clearTimeout(timer);
      if (abort) request.signal.removeEventListener("abort", abort);
      this.pending.delete(commandId);
    }
  }
  receive(connection: ConnectedRunner, result: ComputerToolResult) {
    const call = this.pending.get(result.command_id);
    if (!call) return;
    if (
      call.connection !== connection ||
      connection.connectionEpoch !== result.connection_epoch ||
      call.agentId !== result.agent_id ||
      call.tenantId !== result.tenant_id ||
      call.ownerActorId !== result.owner_actor_id
    )
      throw new Error("Computer tool result identity mismatch");
    call.resolve(result.result);
  }
  disconnected(connection: ConnectedRunner) {
    for (const call of this.pending.values())
      if (call.connection === connection) call.resolve(unknown());
  }
}
