import type {
  AgentRunnerSnapshot,
  DaemonToAgentEnvelope,
} from "@linger/wire-contracts/runner-gateway/types";

import {
  type AgentRunnerCommand,
  type AgentRunnerDesiredRecord,
  type AgentRunnerDesiredState,
  AgentRunnerDesiredStateError,
  type AgentRunnerOutcome,
  type AgentRunnerPlacement,
} from "./agent-runner-desired-state.js";

export interface AgentRunnerReconciliationOptions {
  readonly computerId: string;
  readonly connectionEpoch: number;
  readonly desiredState: AgentRunnerDesiredState;
  readonly createId: () => string;
  readonly send: (command: AgentRunnerCommand) => Promise<void>;
  readonly onReady: () => Promise<void>;
}

/**
 * Brings one connection's Computer to its desired Agent Runners: the set
 * computed at hello first, then each later change. One batch of commands is
 * in flight at a time; a change made meanwhile is sent when it settles.
 */
export class AgentRunnerConnectionReconciliation {
  readonly #computerId: string;
  readonly #connectionEpoch: number;
  readonly #desiredState: AgentRunnerDesiredState;
  readonly #createId: () => string;
  readonly #send: AgentRunnerReconciliationOptions["send"];
  readonly #onReady: AgentRunnerReconciliationOptions["onReady"];
  readonly #pending = new Map<string, AgentRunnerCommand>();
  #reconcileAgain = false;

  constructor(options: AgentRunnerReconciliationOptions) {
    this.#computerId = options.computerId;
    this.#connectionEpoch = options.connectionEpoch;
    this.#desiredState = options.desiredState;
    this.#createId = options.createId;
    this.#send = options.send;
    this.#onReady = options.onReady;
  }

  async start(
    placements: readonly AgentRunnerPlacement[],
    reported: readonly AgentRunnerSnapshot[],
  ): Promise<void> {
    this.#desiredState.reconnect(this.#computerId, placements, reported);
    await this.#dispatch(this.#snapshotCommands());
    if (this.#pending.size === 0) await this.#onReady();
  }

  async apply(record: AgentRunnerDesiredRecord): Promise<void> {
    if (this.#pending.size > 0) {
      this.#reconcileAgain = true;
      return;
    }
    await this.#dispatch([
      this.#desiredState.command(record, this.#commandOptions()),
    ]);
  }

  async receive(outcome: AgentRunnerOutcome): Promise<void> {
    const command = this.#pending.get(outcome.command_id);
    if (!command) {
      throw new AgentRunnerDesiredStateError(
        "Agent Runner outcome targets an unknown desired-state command",
      );
    }
    this.#desiredState.observe(command, outcome);
    this.#pending.delete(outcome.command_id);
    if (this.#pending.size > 0) return;
    if (this.#reconcileAgain) {
      this.#reconcileAgain = false;
      await this.#dispatch(this.#snapshotCommands());
      if (this.#pending.size > 0) return;
    }
    await this.#onReady();
  }

  #snapshotCommands(): AgentRunnerCommand[] {
    return this.#desiredState.snapshotCommands({
      computerId: this.#computerId,
      ...this.#commandOptions(),
    });
  }

  #commandOptions(): {
    readonly connectionEpoch: number;
    readonly createId: () => string;
  } {
    return {
      connectionEpoch: this.#connectionEpoch,
      createId: this.#createId,
    };
  }

  async #dispatch(commands: readonly AgentRunnerCommand[]): Promise<void> {
    if (this.#pending.size > 0) {
      throw new AgentRunnerDesiredStateError(
        "Agent Runner desired-state reconciliation is already active",
      );
    }
    for (const command of commands)
      this.#pending.set(command.command_id, command);
    for (const command of commands) await this.#send(command);
  }
}

export const isAgentRunnerOutcome = (
  envelope: DaemonToAgentEnvelope,
): envelope is AgentRunnerOutcome => envelope.type === "agent_runner.state";
