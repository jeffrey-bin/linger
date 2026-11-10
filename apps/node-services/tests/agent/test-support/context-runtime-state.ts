import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import type { RuntimeSession } from "../../../src/agent/executor/provider.js";
import {
  parseExecutionResources,
  type ContextRuntimeStatePort,
  type ExecutionResources,
  type LocalRun,
  type LocalRunTerminal,
  type MessageSteer,
} from "../../../src/agent/executor/context-runtime-state.js";
import type {
  Message,
  NonEmptyReadonlyArray,
} from "../../../src/agent/executor/types.js";

interface Input {
  message: Message;
  runId?: string;
  groupId?: string;
  outcome?: "applied" | "uncertain";
}
interface State {
  inputs: Map<string, Input>;
  runs: Map<string, LocalRun>;
  messageSteers: MessageSteer[];
  sequence: number;
  session: RuntimeSession;
  executionResources: ExecutionResources | null;
}
const states = new Map<string, State>();

/** A Shell control-port fixture, not a persistence/transaction authority.
 * Sharing an explicit key models reconnects for controller tests. TeamHub/Go
 * tests own durable recovery, lease fencing, and transaction/CAS evidence.
 */
export class TestContextRuntimeState implements ContextRuntimeStatePort {
  readonly #acceptedAt = new Map<string, number>();
  readonly databasePath: string;
  readonly state: State;
  constructor(options: { databasePath: string; ref: ExecutionContextRef }) {
    this.databasePath = options.databasePath;
    const key = `${options.databasePath}:${JSON.stringify(options.ref)}`;
    const existing =
      options.databasePath === ":memory:" ? undefined : states.get(key);
    this.state = existing ?? {
      inputs: new Map(),
      runs: new Map(),
      messageSteers: [],
      sequence: 0,
      session: null,
      executionResources: null,
    };
    if (options.databasePath !== ":memory:") states.set(key, this.state);
    if (existing)
      for (const run of existing.runs.values())
        if (run.status === "running") {
          run.status = "failed";
          run.terminal = {
            type: "failed",
            error: "Agent process interrupted while Local Run was running",
          };
        }
  }
  private record(messages: NonEmptyReadonlyArray<Message>): void {
    for (const message of messages) {
      const old = this.state.inputs.get(message.messageId);
      if (old && !isDeepStrictEqual(old.message, message))
        throw new Error(
          `Message "${message.messageId}" was already received with different content`,
        );
    }
    for (const message of messages)
      if (!this.state.inputs.has(message.messageId)) {
        this.state.inputs.set(message.messageId, {
          message: structuredClone(message),
        });
        this.state.sequence++;
      }
  }
  /** Test seeding: one steer group over Messages no Run has taken yet. */
  openSteerGroup(messages: NonEmptyReadonlyArray<Message>): {
    readonly groupId: string;
    readonly messages: NonEmptyReadonlyArray<Message>;
  } {
    this.record(messages);
    const groupId = `steer-${randomUUID()}`;
    for (const message of messages)
      this.state.inputs.get(message.messageId)!.groupId = groupId;
    return { groupId, messages };
  }
  private queue(
    messages: NonEmptyReadonlyArray<Message>,
    runId = `local-run-${randomUUID()}`,
  ): string {
    this.#acceptedAt.set(runId, performance.now());
    this.state.runs.set(runId, {
      runId,
      initialMessageIds: messages.map(
        (m) => m.messageId,
      ) as unknown as NonEmptyReadonlyArray<string>,
      steerMessageIds: [],
      status: "queued",
      attemptCount: 0,
    });
    for (const m of messages)
      Object.assign(this.state.inputs.get(m.messageId)!, {
        runId,
        groupId: undefined,
      });
    return runId;
  }
  enqueueTrustedTurn(messages: NonEmptyReadonlyArray<Message>): string {
    const existing = this.state.inputs.get(messages[0].messageId)?.runId;
    this.record(messages);
    return existing ?? this.queue(messages);
  }
  cancelTrustedTurn(messages: NonEmptyReadonlyArray<Message>) {
    const runId = this.enqueueTrustedTurn(messages);
    return { runId, status: this.cancelLocalRun(runId) };
  }
  claimLocalRun() {
    if ([...this.state.runs.values()].some((r) => r.status === "running"))
      return null;
    const run = [...this.state.runs.values()].find(
      (r) => r.status === "queued",
    );
    if (!run) return null;
    run.status = "running";
    run.attemptCount++;
    return {
      runId: run.runId,
      acceptedAtMonotonicMs: this.#acceptedAt.get(run.runId),
      attemptCount: run.attemptCount,
      messages: run.initialMessageIds.map(
        (id) => this.state.inputs.get(id)!.message,
      ) as unknown as NonEmptyReadonlyArray<Message>,
    };
  }
  requeueLocalRun(runId: string): void {
    this.requireRun(runId).status = "queued";
  }
  finishLocalRun(
    runId: string,
    terminal: LocalRunTerminal,
    session?: RuntimeSession,
  ): void {
    const run = this.requireRun(runId);
    if (run.status !== "running" && !isDeepStrictEqual(run.terminal, terminal))
      throw new Error(`Local Run "${runId}" cannot enter ${terminal.type}`);
    this.#acceptedAt.delete(runId);
    run.status = terminal.type;
    run.terminal = structuredClone(terminal);
    if (session) this.setRuntimeSession(session);
  }
  cancelLocalRun(runId: string) {
    const run = this.state.runs.get(runId);
    if (!run) return "not_found" as const;
    if (run.status === "running") {
      return "cancel_requested" as const;
    }
    if (run.status !== "queued") return "already_terminal" as const;
    this.#acceptedAt.delete(runId);
    run.status = "canceled";
    run.terminal = { type: "canceled" };
    return "canceled" as const;
  }
  getLocalRun(runId: string): LocalRun | null {
    return structuredClone(this.state.runs.get(runId) ?? null);
  }
  private requireRun(runId: string): LocalRun {
    const r = this.state.runs.get(runId);
    if (!r) throw new Error("Local Run is unavailable");
    return r;
  }
  enqueueSteer(
    groupId: string,
    messages: NonEmptyReadonlyArray<Message>,
  ): string {
    for (const m of messages) {
      const i = this.state.inputs.get(m.messageId)!;
      if (i.groupId !== groupId) throw new Error("Steer group is unavailable");
    }
    return this.queue(messages);
  }
  assignSteerRun(groupId: string, runId: string): void {
    if (this.requireRun(runId).status !== "running")
      throw new Error("Steer target is not a running Local Run");
    for (const input of this.state.inputs.values())
      if (input.groupId === groupId) input.runId = runId;
  }
  completeSteer(
    groupId: string,
    runId: string,
    outcome: "applied" | "uncertain",
  ): void {
    const run = this.requireRun(runId);
    const ids = [...this.state.inputs]
      .filter(([, i]) => i.groupId === groupId && i.runId === runId)
      .map(([id]) => id);
    if (!ids.length)
      throw new Error("Steer group is unavailable for completion");
    run.steerMessageIds = [...run.steerMessageIds, ...ids];
    for (const id of ids)
      Object.assign(this.state.inputs.get(id)!, {
        groupId: undefined,
        outcome,
      });
  }
  getSteerOutcome(messageId: string) {
    return this.state.inputs.get(messageId)?.outcome ?? null;
  }
  acceptTrustedNotification(runId: string, message: Message) {
    if (this.state.inputs.has(message.messageId))
      return { status: "already_accepted" as const };
    if (this.requireRun(runId).status !== "running")
      throw new Error(
        "Trusted notification target is not the active Local Run",
      );
    this.record([message]);
    const groupId = `steer-${randomUUID()}`;
    this.state.inputs.get(message.messageId)!.groupId = groupId;
    return { status: "committed" as const, groupId };
  }
  /** Test seeding: TeamHub queued these Messages as one Run. */
  queueInboxRun(messages: NonEmptyReadonlyArray<Message>): string {
    return this.enqueueTrustedTurn(messages);
  }
  /** Test seeding: TeamHub steered one Message into the running Run. */
  queueMessageSteer(
    message: Message,
    options: { readonly inboxId?: string; readonly runId?: string } = {},
  ): MessageSteer {
    const { groupId } = this.openSteerGroup([message]);
    const steer: MessageSteer = {
      groupId,
      inputId: message.messageId,
      message,
      ...(options.inboxId ? { inboxId: options.inboxId } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
    };
    if (options.runId)
      this.state.inputs.get(message.messageId)!.runId = options.runId;
    this.state.messageSteers.push(steer);
    return steer;
  }
  takeMessageSteers(): readonly MessageSteer[] {
    const steers = this.state.messageSteers;
    this.state.messageSteers = [];
    return steers;
  }
  noteQueuedRun(): void {}
  hasQueuedRuns(): boolean {
    return [...this.state.runs.values()].some((r) => r.status === "queued");
  }
  acceptedInputPending(): boolean {
    return this.#acceptedAt.size > 0;
  }
  earliestAcceptedInputMs(): number | undefined {
    let earliest: number | undefined;
    for (const acceptedAt of this.#acceptedAt.values()) {
      if (earliest === undefined || acceptedAt < earliest)
        earliest = acceptedAt;
    }
    return earliest;
  }
  hasPendingWork(): boolean {
    return (
      [...this.state.inputs.values()].some((i) => i.groupId) ||
      [...this.state.runs.values()].some(
        (r) => r.status === "queued" || r.status === "running",
      )
    );
  }
  getRuntimeSession(): RuntimeSession {
    return structuredClone(this.state.session);
  }
  setRuntimeSession(
    session: RuntimeSession,
    resources?: ExecutionResources | null,
  ): void {
    const capturedResources =
      resources == null ? resources : parseExecutionResources(resources);
    try {
      this.state.session = JSON.parse(
        JSON.stringify(session),
      ) as RuntimeSession;
    } catch {
      throw new TypeError("RuntimeSession must be JSON-serializable");
    }
    if (capturedResources !== undefined)
      this.state.executionResources = capturedResources;
  }
  getExecutionResources(): ExecutionResources | null {
    return this.state.executionResources
      ? parseExecutionResources(this.state.executionResources)
      : null;
  }
  setExecutionResources(resources: ExecutionResources): void {
    this.state.executionResources = parseExecutionResources(resources);
  }
  clearRuntimeSession(): boolean {
    const result =
      this.state.session !== null || this.state.executionResources !== null;
    this.state.session = null;
    this.state.executionResources = null;
    return result;
  }
  close(): void {
    this.#acceptedAt.clear();
  }
}
