import { RUNNER_GATEWAY_PROTOCOL_VERSION } from "@linger/wire-contracts/runner-gateway/validator";
import { isDeepStrictEqual } from "node:util";

import type {
  AgentRunnerEnsure,
  AgentRunnerFailed,
  AgentRunnerReady,
  AgentRunnerRemove,
  AgentRunnerRemoved,
  AgentRunnerSnapshot,
  RuntimeConfig,
} from "@linger/wire-contracts/runner-gateway/types";

export interface AgentRunnerIdentity {
  readonly computerId: string;
  readonly tenantId: string;
  readonly agentId: string;
}

export interface AgentRunnerPlacement extends AgentRunnerIdentity {
  readonly runtime: RuntimeConfig;
  readonly workspaceGrantId: string;
  readonly registrationId: string;
  readonly assignmentRevision: number;
}

export type AgentRunnerCommand = AgentRunnerEnsure | AgentRunnerRemove;

export type AgentRunnerOutcome =
  | AgentRunnerReady
  | AgentRunnerRemoved
  | AgentRunnerFailed;

type ObservedMode = "unknown" | "ready" | "removed" | "failed";

export interface AgentRunnerDesiredRecord extends AgentRunnerIdentity {
  readonly runnerRevision: number;
  readonly desiredMode: "ready" | "removed";
  readonly runtime?: RuntimeConfig;
  readonly workspaceGrantId?: string;
  readonly registrationId?: string;
  readonly assignmentRevision?: number;
  observedMode: ObservedMode;
  observedFailureMessage?: string;
}

export class AgentRunnerDesiredStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunnerDesiredStateError";
  }
}

/**
 * The Agent Runners each connected Computer should hold, kept in memory. A
 * Computer's set is computed when it connects, from the Agents TeamHub places
 * on it and the Runners it reports; a later Run or registration change
 * adjusts it while the connection lasts. Runner revisions only grow on a
 * Computer, so each command advances past what the Computer reported.
 */
export class AgentRunnerDesiredState {
  readonly #records = new Map<string, AgentRunnerDesiredRecord>();

  /**
   * Replaces a connecting Computer's set: a ready Runner for every placement,
   * and the removal of every other Runner the Computer reports. A Runner the
   * Computer already holds as placed keeps its revision.
   */
  reconnect(
    computerId: string,
    placements: readonly AgentRunnerPlacement[],
    reported: readonly AgentRunnerSnapshot[],
  ): void {
    const previous = new Map(
      [...this.#records].filter(
        ([, record]) => record.computerId === computerId,
      ),
    );
    for (const key of previous.keys()) this.#records.delete(key);
    const reportedByKey = new Map(
      reported.map((snapshot) => [
        agentRunnerKey({
          computerId,
          tenantId: snapshot.tenant_id,
          agentId: snapshot.agent_id,
        }),
        snapshot,
      ]),
    );
    for (const placement of placements) {
      const key = agentRunnerKey(placement);
      const snapshot = reportedByKey.get(key);
      reportedByKey.delete(key);
      const known = Math.max(
        snapshot?.runner_revision ?? 0,
        previous.get(key)?.runnerRevision ?? 0,
      );
      const held =
        snapshot?.state === "ready" &&
        snapshot.runner_revision === known &&
        holdsPlacement(snapshot, placement);
      this.#records.set(key, {
        ...placementFields(placement),
        runnerRevision: held ? known : nextRevision(known),
        desiredMode: "ready",
        observedMode: held ? "ready" : "unknown",
      });
    }
    for (const [key, snapshot] of reportedByKey) {
      this.#records.set(key, {
        computerId,
        tenantId: snapshot.tenant_id,
        agentId: snapshot.agent_id,
        runnerRevision: nextRevision(
          Math.max(
            snapshot.runner_revision,
            previous.get(key)?.runnerRevision ?? 0,
          ),
        ),
        desiredMode: "removed",
        observedMode: "unknown",
      });
    }
  }

  /** The record for a ready Runner on this placement, advanced when it changed. */
  ensure(placement: AgentRunnerPlacement): {
    readonly changed: boolean;
    readonly record: AgentRunnerDesiredRecord;
  } {
    validatePlacement(placement);
    const key = agentRunnerKey(placement);
    const current = this.#records.get(key);
    if (
      current?.desiredMode === "ready" &&
      current.observedMode !== "failed" &&
      current.workspaceGrantId === placement.workspaceGrantId &&
      current.registrationId === placement.registrationId &&
      current.assignmentRevision === placement.assignmentRevision &&
      isDeepStrictEqual(current.runtime, placement.runtime)
    ) {
      return { changed: false, record: current };
    }
    const record: AgentRunnerDesiredRecord = {
      ...placementFields(placement),
      runnerRevision: nextRevision(current?.runnerRevision ?? 0),
      desiredMode: "ready",
      observedMode: "unknown",
    };
    this.#records.set(key, record);
    return { changed: true, record };
  }

  /**
   * Removes the Runner, again after a failed removal; nothing when it is
   * already removed or unknown.
   */
  remove(identity: AgentRunnerIdentity): AgentRunnerDesiredRecord | undefined {
    const key = agentRunnerKey(identity);
    const current = this.#records.get(key);
    if (
      !current ||
      (current.desiredMode === "removed" && current.observedMode !== "failed")
    )
      return undefined;
    const record: AgentRunnerDesiredRecord = {
      computerId: current.computerId,
      tenantId: current.tenantId,
      agentId: current.agentId,
      runnerRevision: nextRevision(current.runnerRevision),
      desiredMode: "removed",
      observedMode: "unknown",
    };
    this.#records.set(key, record);
    return record;
  }

  /**
   * Forgets a Computer that is not connected: its next connection computes
   * its set again from TeamHub and what it reports.
   */
  forget(identity: AgentRunnerIdentity): void {
    this.#records.delete(agentRunnerKey(identity));
  }

  forgetComputer(computerId: string): void {
    for (const [key, record] of this.#records)
      if (record.computerId === computerId) this.#records.delete(key);
  }

  recordsForAgent(agentId: string): readonly AgentRunnerDesiredRecord[] {
    return [...this.#records.values()].filter(
      (record) => record.agentId === agentId,
    );
  }

  /** Whether the Computer should hold a ready Runner for the Agent. */
  places(computerId: string, tenantId: string, agentId: string): boolean {
    return (
      this.#records.get(agentRunnerKey({ computerId, tenantId, agentId }))
        ?.desiredMode === "ready"
    );
  }

  snapshotCommands(options: {
    readonly computerId: string;
    readonly connectionEpoch: number;
    readonly createId: () => string;
  }): AgentRunnerCommand[] {
    return [...this.#records.values()]
      .filter(
        (record) =>
          record.computerId === options.computerId &&
          record.observedMode === "unknown",
      )
      .sort(compareRecords)
      .map((record) => this.command(record, options));
  }

  command(
    record: AgentRunnerDesiredRecord,
    options: {
      readonly connectionEpoch: number;
      readonly createId: () => string;
    },
  ): AgentRunnerCommand {
    const identity = {
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: options.createId(),
      runner_id: record.computerId,
      tenant_id: record.tenantId,
      agent_id: record.agentId,
      connection_epoch: options.connectionEpoch,
      runner_revision: record.runnerRevision,
    };
    if (record.desiredMode === "removed")
      return { ...identity, type: "agent_runner.remove" };
    if (
      !record.runtime ||
      !record.workspaceGrantId ||
      !record.registrationId ||
      record.assignmentRevision === undefined
    ) {
      throw new AgentRunnerDesiredStateError(
        "Agent Runner desired state is missing placement",
      );
    }
    return {
      ...identity,
      type: "agent_runner.ensure",
      runtime: record.runtime,
      registration_id: record.registrationId,
      assignment_revision: record.assignmentRevision,
      workspace_grant_id: record.workspaceGrantId,
    };
  }

  observe(command: AgentRunnerCommand, outcome: AgentRunnerOutcome): void {
    assertOutcomeIdentity(command, outcome);
    const expected =
      command.type === "agent_runner.remove" ? "removed" : "ready";
    if (outcome.state !== expected && outcome.state !== "failed") {
      throw new AgentRunnerDesiredStateError(
        "Agent Runner outcome does not match its desired-state command",
      );
    }
    const current = this.#records.get(
      agentRunnerKey({
        computerId: command.runner_id,
        tenantId: command.tenant_id,
        agentId: command.agent_id,
      }),
    );
    if (current?.runnerRevision !== command.runner_revision) return;
    current.observedMode = outcome.state;
    current.observedFailureMessage =
      outcome.state === "failed" ? outcome.error.message : undefined;
  }

  assertOperation(
    placement: Omit<
      AgentRunnerPlacement,
      "registrationId" | "assignmentRevision"
    >,
  ): AgentRunnerDesiredRecord &
    Required<
      Pick<AgentRunnerDesiredRecord, "registrationId" | "assignmentRevision">
    > {
    const record = this.#records.get(agentRunnerKey(placement));
    if (record?.desiredMode !== "ready" || record.observedMode !== "ready") {
      throw new AgentRunnerDesiredStateError(
        "Agent Runner desired state is not ready",
      );
    }
    if (
      record.workspaceGrantId !== placement.workspaceGrantId ||
      !isDeepStrictEqual(record.runtime, placement.runtime) ||
      record.registrationId === undefined ||
      record.assignmentRevision === undefined
    ) {
      throw new AgentRunnerDesiredStateError(
        "Agent Runner placement does not match Operation",
      );
    }
    return record as AgentRunnerDesiredRecord &
      Required<
        Pick<AgentRunnerDesiredRecord, "registrationId" | "assignmentRevision">
      >;
  }

  /**
   * The same record `assertOperation` would return, or undefined when this
   * process has no ready desired state for the placement.
   */
  readyOperation(
    placement: Omit<
      AgentRunnerPlacement,
      "registrationId" | "assignmentRevision"
    >,
  ): ReturnType<AgentRunnerDesiredState["assertOperation"]> | undefined {
    try {
      return this.assertOperation(placement);
    } catch (error) {
      if (error instanceof AgentRunnerDesiredStateError) return undefined;
      throw error;
    }
  }

  assertContextView(
    identity: AgentRunnerIdentity & {
      readonly runnerRevision: number;
      readonly workspaceGrantId: string;
    },
  ): ReturnType<AgentRunnerDesiredState["assertOperation"]> {
    const record = this.#records.get(agentRunnerKey(identity));
    if (
      record?.desiredMode !== "ready" ||
      record.observedMode !== "ready" ||
      record.runnerRevision !== identity.runnerRevision ||
      record.workspaceGrantId !== identity.workspaceGrantId ||
      record.registrationId === undefined ||
      record.assignmentRevision === undefined
    ) {
      throw new AgentRunnerDesiredStateError(
        "Agent Runner placement does not match Context View",
      );
    }
    return record as ReturnType<AgentRunnerDesiredState["assertOperation"]>;
  }

  /** Whether the Computer has confirmed this revision of a ready Runner. */
  observedState(
    identity: AgentRunnerIdentity,
    runnerRevision: number,
  ):
    | { readonly state: "pending" }
    | { readonly state: "matched" }
    | { readonly state: "failed"; readonly message: string } {
    const record = this.#records.get(agentRunnerKey(identity));
    if (
      record?.runnerRevision !== runnerRevision ||
      record.desiredMode !== "ready"
    ) {
      return { state: "pending" };
    }
    if (record.observedMode === "ready") return { state: "matched" };
    if (record.observedMode === "failed") {
      return {
        state: "failed",
        message:
          record.observedFailureMessage ??
          "Local Agent Runner failed to become ready",
      };
    }
    return { state: "pending" };
  }
}

const placementFields = (placement: AgentRunnerPlacement) => ({
  computerId: placement.computerId,
  tenantId: placement.tenantId,
  agentId: placement.agentId,
  runtime: structuredClone(placement.runtime),
  workspaceGrantId: placement.workspaceGrantId,
  registrationId: placement.registrationId,
  assignmentRevision: placement.assignmentRevision,
});

const holdsPlacement = (
  snapshot: Extract<AgentRunnerSnapshot, { state: "ready" }>,
  placement: AgentRunnerPlacement,
): boolean =>
  snapshot.registration_id === placement.registrationId &&
  snapshot.assignment_revision === placement.assignmentRevision &&
  snapshot.workspace_grant_id === placement.workspaceGrantId &&
  isDeepStrictEqual(snapshot.runtime, placement.runtime);

const assertOutcomeIdentity = (
  command: AgentRunnerCommand,
  outcome: AgentRunnerOutcome,
): void => {
  if (
    outcome.command_id !== command.command_id ||
    outcome.runner_id !== command.runner_id ||
    outcome.tenant_id !== command.tenant_id ||
    outcome.registration_id !== command.registration_id ||
    outcome.assignment_revision !== command.assignment_revision ||
    outcome.agent_id !== command.agent_id ||
    outcome.connection_epoch !== command.connection_epoch ||
    outcome.runner_revision !== command.runner_revision
  ) {
    throw new AgentRunnerDesiredStateError(
      "Agent Runner outcome does not match its command fencing identity",
    );
  }
};

const validatePlacement = (placement: AgentRunnerPlacement): void => {
  if (
    [placement.computerId, placement.tenantId, placement.agentId].some(
      (value) => typeof value !== "string" || value.trim().length === 0,
    ) ||
    placement.workspaceGrantId.trim().length === 0 ||
    !placement.registrationId ||
    !Number.isSafeInteger(placement.assignmentRevision) ||
    placement.assignmentRevision < 1
  ) {
    throw new AgentRunnerDesiredStateError("Agent Runner placement is invalid");
  }
};

const nextRevision = (current: number): number => {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current >= Number.MAX_SAFE_INTEGER
  ) {
    throw new AgentRunnerDesiredStateError(
      "Agent Runner revision is exhausted",
    );
  }
  return current + 1;
};

export const agentRunnerKey = (identity: AgentRunnerIdentity): string =>
  `${identity.computerId}\0${identity.tenantId}\0${identity.agentId}`;

const compareRecords = (
  left: AgentRunnerIdentity,
  right: AgentRunnerIdentity,
): number =>
  left.tenantId.localeCompare(right.tenantId) ||
  left.agentId.localeCompare(right.agentId);
