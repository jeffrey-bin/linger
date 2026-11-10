import type {
  AgentCliCredentialPut,
  AgentCliCredentialReport,
  AgentToDaemonEnvelope,
  DaemonToAgentEnvelope,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseAgentToDaemonEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentCliCredentialIssuer,
  AgentCliProfile,
} from "./agent-cli-credential-issuer.js";
import {
  AgentRunnerDesiredStateError,
  type AgentRunnerDesiredRecord,
  type AgentRunnerOutcome,
} from "./agent-runner-desired-state.js";
import { LocalComputerOfflineError } from "./local-computer-management.js";
import { isServingConnection } from "./runner-connections.js";
import type {
  AgentCliCredentialEnsure,
  AgentCliCredentialOutcome,
  AgentCliCredentialState,
  AgentCliCredentialWaiter,
  ConnectedRunner,
  RunnerGatewayContext,
  RunnerGatewayControllers,
  StoredAgentCliCredential,
} from "./runner-gateway-context.js";
import {
  RunnerGatewayError,
  RunnerGatewayProtocolError,
  RunnerOperationError,
} from "./runner-operation.js";

export class RunnerCliCredentials {
  readonly #agentCliCredentialWaiters = new Map<
    string,
    AgentCliCredentialWaiter
  >();

  // Keyed by connection object; a reconnect learns again from agent_runner.state ready.
  readonly #agentCliCredentials = new WeakMap<
    ConnectedRunner,
    AgentCliCredentialState
  >();

  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<
      RunnerGatewayControllers,
      "connections" | "lifecycle"
    >,
  ) {}

  /**
   * Makes sure the Agent's Computer holds the Agent's long-term CLI
   * credential for its current Runtime Assignment. The Computer reports what
   * it holds in agent_runner.state ready and executed cli_credential. The
   * first Run of an Agent on a connection asks TeamHub once whether a
   * reported token is still live; after that a held credential costs no
   * request. Otherwise one issuance per Agent, connection and assignment
   * obtains the credential from TeamHub, which revokes the previous one, and
   * pushes it over the live connection; the token never reaches TeamHub
   * records or logs.
   */
  async ensureAgentCliCredential(
    options: AgentCliCredentialEnsure,
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const connection = this.owners
      .connections()
      .getConnection(options.computerId);
    if (!isServingConnection(connection)) {
      throw new LocalComputerOfflineError();
    }
    const issuer = this.context.agentCliCredentialIssuer;
    if (!issuer) {
      throw new RunnerGatewayError(
        "Agent CLI credential issuance is not configured",
      );
    }
    const desired = this.#assertAgentCliCredentialRunner(connection, options);
    const profile = issuer.profile(options);
    const key = agentCliCredentialKey(options);
    const state = this.#agentCliCredentialState(connection);
    const held = state.stored.get(key);
    if (
      held?.verified === true &&
      held.assignmentRevision === desired.assignmentRevision &&
      isDeepStrictEqual(held.profile, profile)
    )
      return;
    let issuance = state.issuances.get(key);
    if (
      !issuance ||
      issuance.assignmentRevision !== desired.assignmentRevision
    ) {
      const started: Promise<void> = this.#issueAgentCliCredential(
        connection,
        state,
        key,
        profile,
        issuer,
        options,
      ).finally(() => {
        if (state.issuances.get(key)?.work === started)
          state.issuances.delete(key);
      });
      issuance = {
        assignmentRevision: desired.assignmentRevision,
        work: started,
      };
      state.issuances.set(key, issuance);
    }
    await waitUnlessAborted(issuance.work, options.signal);
  }

  #agentCliCredentialState(
    connection: ConnectedRunner,
  ): AgentCliCredentialState {
    let state = this.#agentCliCredentials.get(connection);
    if (!state) {
      state = { stored: new Map(), issuances: new Map() };
      this.#agentCliCredentials.set(connection, state);
    }
    return state;
  }

  #assertAgentCliCredentialRunner(
    connection: ConnectedRunner,
    options: AgentCliCredentialEnsure,
  ): AgentRunnerDesiredRecord {
    this.owners.connections().assertCurrentConnection(connection);
    try {
      return this.owners.lifecycle().desiredAssertContextView(options);
    } catch (error) {
      if (error instanceof AgentRunnerDesiredStateError)
        throw new RunnerGatewayError(error.message);
      throw error;
    }
  }

  async #issueAgentCliCredential(
    connection: ConnectedRunner,
    state: AgentCliCredentialState,
    key: string,
    profile: AgentCliProfile,
    issuer: AgentCliCredentialIssuer,
    options: AgentCliCredentialEnsure,
  ): Promise<void> {
    const desiredNow = this.#assertAgentCliCredentialRunner(
      connection,
      options,
    );
    const held = state.stored.get(key);
    const heldSha256 =
      held !== undefined &&
      held.assignmentRevision === desiredNow.assignmentRevision &&
      isDeepStrictEqual(held.profile, profile)
        ? held.sha256
        : undefined;
    // Issuance revokes whatever the Computer holds, so forget it first: a
    // failed push must lead to a new issuance, not to the revoked token.
    state.stored.delete(key);
    try {
      const credential = await issuer.issue(
        options,
        {
          computerId: connection.runnerId,
          workspaceGrantId: options.workspaceGrantId,
        },
        heldSha256,
      );
      const desired = this.#assertAgentCliCredentialRunner(connection, options);
      if (credential === "current") {
        if (held !== undefined)
          state.stored.set(key, { ...held, verified: true });
        return;
      }
      const stored = await this.#pushAgentCliCredential(
        connection,
        desired,
        profile,
        credential,
        options,
      );
      this.#assertAgentCliCredentialRunner(connection, options);
      state.stored.set(key, stored);
    } catch (error) {
      // A replaced connection or Runner explains the failure better.
      this.#assertAgentCliCredentialRunner(connection, options);
      throw error;
    }
  }

  async #pushAgentCliCredential(
    connection: ConnectedRunner,
    desired: AgentRunnerDesiredRecord,
    profile: AgentCliProfile,
    credential: { readonly accessToken: string },
    options: AgentCliCredentialEnsure,
  ): Promise<StoredAgentCliCredential> {
    let command: AgentToDaemonEnvelope;
    try {
      command = parseAgentToDaemonEnvelope({
        type: "execute",
        kind: "cli_credential",
        protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
        command_id: this.context.createId(),
        tenant_id: options.tenantId,
        runner_id: options.computerId,
        agent_id: options.agentId,
        connection_epoch: connection.connectionEpoch,
        runner_revision: options.runnerRevision,
        registration_id: desired.registrationId,
        assignment_revision: desired.assignmentRevision,
        profile: {
          url: profile.url,
          tenant_id: profile.tenantId,
          agent_id: profile.agentId,
        },
        access_token: credential.accessToken,
      });
    } catch {
      // Validation messages can echo the rejected value, which is the token.
      throw new RunnerGatewayProtocolError(
        "Invalid Agent CLI credential command",
      );
    }
    if (command.type !== "execute" || command.kind !== "cli_credential") {
      throw new RunnerGatewayProtocolError(
        "Invalid Agent CLI credential command",
      );
    }
    const outcome = this.#waitForAgentCliCredentialOutcome(
      command,
      AbortSignal.timeout(AGENT_CLI_CREDENTIAL_PUSH_TIMEOUT_MS),
    );
    try {
      await this.owners.connections().send(connection, command);
    } catch (error) {
      if (
        this.owners.connections().getConnection(connection.runnerId) ===
        connection
      )
        this.owners.connections().disconnect(connection);
      this.#finishAgentCliCredential(command.command_id, { error });
    }
    const result = await outcome;
    if (result.outcome === "failed") {
      throw new RunnerOperationError(
        result.error.code,
        `Agent CLI credential failed: ${result.error.message}`,
        result.error.retryable,
      );
    }
    const sha256 = createHash("sha256")
      .update(credential.accessToken)
      .digest("hex");
    if (result.sha256 !== sha256) {
      throw new RunnerGatewayProtocolError(
        "Agent CLI credential digest mismatch",
      );
    }
    return {
      assignmentRevision: command.assignment_revision,
      profile,
      sha256,
      verified: true,
    };
  }

  receiveAgentCliCredentialOutcome(
    connection: ConnectedRunner,
    outcome: AgentCliCredentialOutcome,
  ): void {
    const waiter = this.#agentCliCredentialWaiters.get(outcome.command_id);
    if (!waiter) return;
    this.owners.connections().assertCurrentConnection(connection);
    for (const key of Object.keys(waiter.identity) as Array<
      keyof typeof waiter.identity
    >) {
      if (waiter.identity[key] !== outcome[key]) {
        throw new RunnerGatewayProtocolError(
          `Agent CLI credential outcome identity mismatch at ${key}`,
        );
      }
    }
    this.#finishAgentCliCredential(outcome.command_id, { outcome });
  }

  #waitForAgentCliCredentialOutcome(
    command: AgentCliCredentialPut,
    signal?: AbortSignal,
  ): Promise<AgentCliCredentialOutcome> {
    const commandId = command.command_id;
    return new Promise<AgentCliCredentialOutcome>((resolve, reject) => {
      const onAbort = () =>
        this.#finishAgentCliCredential(commandId, {
          error:
            signal?.reason ??
            new Error("Agent CLI credential push was cancelled"),
        });
      this.#agentCliCredentialWaiters.set(commandId, {
        // Copy only the admitted identity before handing the command to the
        // transport. Never retain a token in the response-matching state.
        identity: {
          protocol_version: command.protocol_version,
          command_id: commandId,
          tenant_id: command.tenant_id,
          registration_id: command.registration_id,
          assignment_revision: command.assignment_revision,
          runner_id: command.runner_id,
          agent_id: command.agent_id,
          connection_epoch: command.connection_epoch,
          runner_revision: command.runner_revision,
        },
        signal,
        onAbort,
        resolve,
        reject,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  #finishAgentCliCredential(
    commandId: string,
    result:
      | { readonly outcome: AgentCliCredentialOutcome }
      | { readonly error: unknown },
  ): void {
    const waiter = this.#agentCliCredentialWaiters.get(commandId);
    if (!waiter) return;
    this.#agentCliCredentialWaiters.delete(commandId);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    if ("outcome" in result) waiter.resolve(result.outcome);
    else waiter.reject(result.error);
  }

  observeAgentRunnerOutcome(
    connection: ConnectedRunner,
    outcome: AgentRunnerOutcome,
  ): void {
    // Record what the Computer holds before readiness waiters run, so the
    // Run they release finds it. An outcome that fails validation below
    // closes the connection, and this per-connection record with it.
    if (outcome.state !== "failed") {
      const key = agentCliCredentialKey({
        tenantId: outcome.tenant_id,
        agentId: outcome.agent_id,
      });
      const { stored, issuances } = this.#agentCliCredentialState(connection);
      if (outcome.state === "ready" && outcome.cli_credential)
        stored.set(
          key,
          storedAgentCliCredential(outcome.cli_credential, stored.get(key)),
        );
      else stored.delete(key);
      if (outcome.state === "removed") issuances.delete(key);
    }
  }

  rejectCredentialWaitersForComputer(runnerId: string): void {
    for (const [commandId, waiter] of this.#agentCliCredentialWaiters) {
      if (waiter.identity.runner_id !== runnerId) continue;
      this.#finishAgentCliCredential(commandId, {
        error: new LocalComputerOfflineError(),
      });
    }
  }
}

export const isAgentCliCredentialOutcome = (
  envelope: DaemonToAgentEnvelope,
): envelope is AgentCliCredentialOutcome =>
  envelope.type === "executed" && envelope.kind === "cli_credential";

// The shared push has no caller to bound it.
const AGENT_CLI_CREDENTIAL_PUSH_TIMEOUT_MS = 30_000;

const agentCliCredentialKey = (identity: {
  readonly tenantId: string;
  readonly agentId: string;
}): string => [identity.tenantId, identity.agentId].join("\u0000");

/** A report keeps the check of the same token for the same assignment. */
const storedAgentCliCredential = (
  report: AgentCliCredentialReport,
  previous: StoredAgentCliCredential | undefined,
): StoredAgentCliCredential => ({
  assignmentRevision: report.assignment_revision,
  profile: {
    url: report.profile.url,
    tenantId: report.profile.tenant_id,
    agentId: report.profile.agent_id,
  },
  sha256: report.sha256,
  verified:
    previous?.verified === true &&
    previous.sha256 === report.sha256 &&
    previous.assignmentRevision === report.assignment_revision,
});

/** Waits for shared work; the caller's signal cancels only its own wait. */
const waitUnlessAborted = <T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  if (!signal) return work;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
};
