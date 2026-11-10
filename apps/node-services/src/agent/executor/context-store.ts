import { setTimeout as delay } from "node:timers/promises";
import { createAgentLogger } from "../observability/agent-log.js";
import type { ExecutionContextRef } from "./context-ref.js";
import {
  encodeExecutionContextRef,
  type ContextTargetResidency,
  type EnsureExecutionContextResult,
  type ExecutionContextRecord,
  type ExecutionContextStore,
  type SharedTaskScope,
} from "./context-ref.js";
import {
  TeamHubRuntimeStateError,
  type AcceptedContextState,
  type RuntimeContext,
  type TeamHubRuntimeStateClient,
  isTeamHubNotFound,
} from "./teamhub-runtime-state-client.js";

const RECONCILE_PAGE_LIMIT = 1_000;
const REFRESH_CONCURRENCY = 8;
// Bound incidental reads of Contexts this process does not hold.
const UNHELD_RECORD_LIMIT = 64;

/**
 * "work": TeamHub queued work for the Context; "ensure": an explicit request
 * to hold it; "changed": a change hint, which binds an unheld Context only
 * when it is a Room Meta Context that never ran.
 */
type BindMode = "work" | "ensure" | "changed";

export interface TeamHubContextReconciliationSummary {
  readonly examinedCount: number;
  readonly existingCount: number;
  readonly createdCount: number;
}

export interface TeamHubContextStoreStartup {
  readonly reconciliation: TeamHubContextReconciliationSummary;
  /** Contexts with a queued Run or Message steer when this epoch opened. */
  readonly waitingContextKeys: readonly string[];
}

export interface TeamHubExecutionContextStoreOptions {
  readonly client: TeamHubRuntimeStateClient;
}

/**
 * TeamHub-backed Context identity and the set of Contexts this process holds.
 * One Agent Service process runs against a database and opens an epoch at
 * start, so holding a Context needs no lease: the process binds a Context
 * when work or a request arrives and releases it locally when it idles.
 * PostgreSQL remains the source of every recoverable Context fact.
 */
export class TeamHubExecutionContextStore implements ExecutionContextStore {
  readonly #client: TeamHubRuntimeStateClient;
  readonly #records = new Map<string, ExecutionContextRecord>();
  readonly #contexts = new Map<string, RuntimeContext>();
  readonly #held = new Set<string>();
  readonly #binds = new Map<
    string,
    { mode: BindMode; promise: Promise<ExecutionContextRecord | null> }
  >();
  readonly #listeners = new Set<
    (record: Readonly<ExecutionContextRecord>) => void
  >();
  readonly #unbindListeners = new Set<
    (ref: Readonly<ExecutionContextRef>) => void
  >();
  #observationSequence = 0;
  readonly #observations = new Set<number>();
  readonly #invalidations = new Map<string, number>();
  #started = false;
  #starting: Promise<TeamHubContextStoreStartup> | null = null;
  #refreshing: Promise<void> | null = null;
  readonly #startupAbort = new AbortController();
  #closed = false;

  constructor(options: TeamHubExecutionContextStoreOptions) {
    this.#client = options.client;
  }

  get epoch(): string {
    return this.#client.epoch;
  }

  /**
   * Opens this process's epoch and reconciles Room Meta Contexts. TeamHub
   * has interrupted the Runs of the previous epoch; the Contexts with queued
   * work are returned for the caller to take up.
   */
  start(signal?: AbortSignal): Promise<TeamHubContextStoreStartup> {
    this.#assertOpen();
    if (this.#starting) return this.#starting;
    if (this.#started)
      throw new Error("TeamHub Execution Context store already started");
    const startupSignal = signal
      ? AbortSignal.any([signal, this.#startupAbort.signal])
      : this.#startupAbort.signal;
    const starting = this.#start(startupSignal).finally(() => {
      this.#starting = null;
    });
    this.#starting = starting;
    return starting;
  }

  async #start(signal: AbortSignal): Promise<TeamHubContextStoreStartup> {
    const logger = createAgentLogger({ component: "runtime-state" });
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try {
        const opened = await this.#client.startEpoch(signal);
        logger.log("info", "contexts.epoch_started", {
          epoch: this.#client.epoch,
          interruptedRuns: opened.interrupted_run_ids.length,
          waitingContexts: opened.waiting_context_keys.length,
        });
        const reconciliation = await this.#reconcileMetaContexts(signal);
        signal.throwIfAborted();
        this.#started = true;
        return {
          reconciliation,
          waitingContextKeys: opened.waiting_context_keys,
        };
      } catch (error) {
        signal.throwIfAborted();
        if (
          !(error instanceof TeamHubRuntimeStateError) ||
          !error.retryable ||
          attempt >= 5
        )
          throw error;
        const delayMs = 1_000 * 2 ** (attempt - 1);
        logger.log("warn", "contexts.startup_retry", {
          attempt,
          delayMs,
          status: error.status,
        });
        await delay(delayMs, undefined, { signal });
      }
    }
  }

  /**
   * Binds a Context to this process. stateRevision is a change hint's
   * committed revision: a held record already at or past it needs no read.
   */
  claimByKey(
    contextKey: string,
    refreshRecord = false,
    mode: BindMode = "work",
    stateRevision?: string,
  ): Promise<ExecutionContextRecord | null> {
    this.#assertOpen();
    const pending = this.#binds.get(contextKey);
    if (pending) {
      // A hint can resolve without binding an explicit request.
      return mode !== "changed" && pending.mode === "changed"
        ? pending.promise.then(
            (record) =>
              record ??
              this.claimByKey(contextKey, refreshRecord, mode, stateRevision),
          )
        : pending.promise;
    }
    const entry = {
      mode,
      promise: Promise.resolve<ExecutionContextRecord | null>(null),
    };
    entry.promise = this.#bind(
      contextKey,
      refreshRecord,
      mode,
      stateRevision,
    ).finally(() => {
      if (this.#binds.get(contextKey) === entry) this.#binds.delete(contextKey);
    });
    this.#binds.set(contextKey, entry);
    return entry.promise;
  }

  async #bind(
    contextKey: string,
    refreshRecord: boolean,
    mode: BindMode,
    stateRevision: string | undefined,
  ): Promise<ExecutionContextRecord | null> {
    if (this.#held.has(contextKey)) {
      const held = this.#contexts.get(contextKey)?.state_revision;
      const current =
        stateRevision !== undefined &&
        held !== undefined &&
        BigInt(held) >= BigInt(stateRevision);
      if (!refreshRecord || current)
        return this.#records.get(contextKey) ?? null;
    }
    const observation = this.#beginObservation();
    try {
      let context: RuntimeContext;
      try {
        context = await this.#client.getContext(contextKey);
      } catch (error) {
        if (isTeamHubNotFound(error)) return null;
        throw error;
      }
      if (this.#closed || !this.#isCurrentObservation(contextKey, observation))
        return this.#held.has(contextKey)
          ? (this.#records.get(contextKey) ?? null)
          : null;
      const bind =
        this.#held.has(contextKey) ||
        mode !== "changed" ||
        isUnusedRoomContext(context);
      if (context.terminal_reason !== undefined || !bind) {
        this.#remember(context, false);
        return null;
      }
      return this.#remember(context, true);
    } finally {
      this.#endObservation(observation);
    }
  }

  /**
   * Releases a suspended Context this process holds. Its Runtime resources
   * stop; queued work arriving later binds it again.
   */
  async releaseIfIdle(ref: ExecutionContextRef): Promise<boolean> {
    this.#assertOpen();
    const key = encodeExecutionContextRef(ref);
    const record = this.#records.get(key);
    if (!this.#held.has(key) || !record || record.targetResidency === "active")
      return false;
    this.#unbind(key, record.ref);
    return true;
  }

  async ensure(
    ref: ExecutionContextRef,
    initialTargetResidency: ContextTargetResidency = "active",
  ): Promise<EnsureExecutionContextResult> {
    this.#assertOpen();
    assertResidency(initialTargetResidency);
    const key = encodeExecutionContextRef(ref);
    const observation = this.#beginObservation();
    try {
      const result = await this.#client.ensureContext({
        ref: toWireRef(ref),
        target_residency: initialTargetResidency,
      });
      this.#assertOpen();
      if (result.context.terminal_reason !== undefined)
        throw new Error(`Execution Context ${key} is terminal`);
      const record = this.#isCurrentObservation(key, observation)
        ? this.#remember(result.context, true)
        : (this.#records.get(key) ??
          (await this.claimByKey(key, true, "ensure")));
      if (!record) throw new Error(`Execution Context ${key} was not bound`);
      return { created: result.created, record };
    } finally {
      this.#endObservation(observation);
    }
  }

  /**
   * Re-reads every held Context after change hints may have been lost.
   */
  refreshAvailableContexts(): Promise<void> {
    this.#assertOpen();
    if (!this.#started) {
      throw new Error("TeamHub Execution Context store has not started");
    }
    if (this.#refreshing) return this.#refreshing;
    const refresh = this.#refreshHeld().finally(() => {
      if (this.#refreshing === refresh) this.#refreshing = null;
    });
    this.#refreshing = refresh;
    return refresh;
  }

  async #refreshHeld(): Promise<void> {
    const keys = [...this.#held];
    for (let offset = 0; offset < keys.length; offset += REFRESH_CONCURRENCY) {
      await Promise.all(
        keys
          .slice(offset, offset + REFRESH_CONCURRENCY)
          .map((key) => this.claimByKey(key, true, "changed")),
      );
    }
  }

  /**
   * Applies the Context state an input acceptance committed, so a held record
   * follows TeamHub without another read. An older state never applies.
   */
  observeCommittedState(
    ref: ExecutionContextRef,
    state: AcceptedContextState,
  ): void {
    this.#assertOpen();
    const key = encodeExecutionContextRef(ref);
    const remembered = this.#contexts.get(key);
    if (
      !remembered ||
      !this.#held.has(key) ||
      BigInt(state.state_revision) <= BigInt(remembered.state_revision)
    )
      return;
    this.#remember({ ...remembered, ...state }, true);
  }

  /**
   * A Run claim or Session checkpoint advances state_revision by one but
   * returns no Context state. Call before the write and invoke the result
   * after it commits: when nothing else was observed meanwhile, the held
   * revision follows the write, so its own context.changed hint does not
   * read the Context back.
   */
  trackOwnRevisionAdvance(ref: ExecutionContextRef): () => void {
    this.#assertOpen();
    const key = encodeExecutionContextRef(ref);
    const base = this.#contexts.get(key)?.state_revision;
    return () => {
      const current = this.#contexts.get(key);
      if (
        this.#closed ||
        base === undefined ||
        !this.#held.has(key) ||
        current?.state_revision !== base
      )
        return;
      this.#contexts.set(key, {
        ...current,
        state_revision: (BigInt(base) + 1n).toString(),
      });
    };
  }

  cached(ref: ExecutionContextRef): ExecutionContextRecord | null {
    return this.#records.get(encodeExecutionContextRef(ref)) ?? null;
  }

  async get(ref: ExecutionContextRef): Promise<ExecutionContextRecord | null> {
    this.#assertOpen();
    const key = encodeExecutionContextRef(ref);
    const observation = this.#beginObservation();
    try {
      const context = await this.#client.getContext(key);
      if (this.#closed || !this.#isCurrentObservation(key, observation))
        return this.#records.get(key) ?? null;
      return this.#remember(context, this.#held.has(key));
    } catch (error) {
      if (isTeamHubNotFound(error)) return null;
      throw error;
    } finally {
      this.#endObservation(observation);
    }
  }

  async list(): Promise<readonly ExecutionContextRecord[]> {
    this.#assertOpen();
    return [...this.#held].flatMap((key) => {
      const record = this.#records.get(key);
      return record ? [record] : [];
    });
  }

  /** A Room Meta Context that has never taken up input. */
  isUnusedContext(ref: ExecutionContextRef): boolean {
    const context = this.#contexts.get(encodeExecutionContextRef(ref));
    return context !== undefined && isUnusedRoomContext(context);
  }

  async listByAgent(
    agentId: string,
  ): Promise<readonly ExecutionContextRecord[]> {
    this.#assertOpen();
    if (!agentId.trim()) throw new TypeError("agentId must not be empty");
    // Deletion and configuration enumerate every Context, held or not.
    const contexts = await this.#client.listContexts(agentId);
    return contexts.map(contextRecord);
  }

  async setTargetResidency(
    ref: ExecutionContextRef,
    targetResidency: ContextTargetResidency,
  ): Promise<"updated" | "not_found"> {
    this.#assertOpen();
    assertResidency(targetResidency);
    const contextKey = encodeExecutionContextRef(ref);
    const current = await this.get(ref);
    if (!current) return "not_found";
    const revision = this.#contexts.get(contextKey)?.state_revision;
    if (!revision)
      throw new Error("Execution Context CAS revision was not retained");
    let updated: RuntimeContext;
    try {
      updated = await this.#client.setContextResidency({
        context_key: contextKey,
        expected_revision: revision,
        target_residency: targetResidency,
      });
    } catch (error) {
      if (isTeamHubNotFound(error)) return "not_found";
      throw error;
    }
    this.#remember(
      updated,
      this.#held.has(contextKey) || targetResidency === "active",
    );
    return "updated";
  }

  async remove(ref: ExecutionContextRef): Promise<"removed" | "not_found"> {
    this.#assertOpen();
    const contextKey = encodeExecutionContextRef(ref);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.get(ref);
      if (!current) return "not_found";
      const revision = this.#contexts.get(contextKey)?.state_revision;
      if (!revision)
        throw new Error("Execution Context CAS revision was not retained");
      try {
        await this.#client.deleteContext({
          context_key: contextKey,
          expected_revision: revision,
        });
        this.#forget(contextKey);
        return "removed";
      } catch (error) {
        if (isTeamHubNotFound(error)) return "not_found";
        if (isConflict(error)) continue;
        throw error;
      }
    }
    throw new Error(
      `Execution Context ${contextKey} delete remained conflicted`,
    );
  }

  async removeByAgent(agentId: string): Promise<number> {
    this.#assertOpen();
    const records = await this.listByAgent(agentId);
    let removed = 0;
    for (const record of records) {
      if ((await this.remove(record.ref)) === "removed") removed += 1;
    }
    return removed;
  }

  subscribe(
    listener: (record: Readonly<ExecutionContextRecord>) => void,
  ): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeUnbind(
    listener: (ref: Readonly<ExecutionContextRef>) => void,
  ): () => void {
    this.#assertOpen();
    this.#unbindListeners.add(listener);
    return () => this.#unbindListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#startupAbort.abort();
    await this.#starting?.catch(() => undefined);
    await Promise.all([
      this.#refreshing?.catch(() => undefined),
      ...[...this.#binds.values()].map((entry) =>
        entry.promise.catch(() => undefined),
      ),
    ]);
    this.#held.clear();
    this.#records.clear();
    this.#contexts.clear();
    this.#listeners.clear();
    this.#unbindListeners.clear();
  }

  async #reconcileMetaContexts(
    signal?: AbortSignal,
  ): Promise<TeamHubContextReconciliationSummary> {
    let cursor: string | undefined;
    let examinedCount = 0;
    let existingCount = 0;
    let createdCount = 0;
    const seenCursors = new Set<string>();
    for (;;) {
      signal?.throwIfAborted();
      const page = await this.#client.reconcileContexts(
        {
          limit: RECONCILE_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        },
        signal,
      );
      examinedCount += page.examined_count;
      existingCount += page.existing_count;
      createdCount += page.created_count;
      if (!page.next_cursor) {
        return Object.freeze({
          examinedCount,
          existingCount,
          createdCount,
        });
      }
      if (seenCursors.has(page.next_cursor)) {
        throw new Error(
          "TeamHub Context reconciliation cursor did not advance",
        );
      }
      seenCursors.add(page.next_cursor);
      cursor = page.next_cursor;
    }
  }

  /**
   * Records a Context observation and publishes held changes. A terminal
   * Context or a new Room membership unbinds the Context: what this process
   * prepared for it must stop before the new record applies.
   */
  #remember(context: RuntimeContext, hold: boolean): ExecutionContextRecord {
    const key = context.context_key;
    const remembered = this.#contexts.get(key);
    // An older read can arrive after a newer one; revisions never go back.
    if (
      remembered &&
      BigInt(context.state_revision) < BigInt(remembered.state_revision)
    ) {
      return this.#records.get(key)!;
    }
    const record = contextRecord(context);
    const previous = this.#records.get(key);
    const wasHeld = this.#held.has(key);
    const rebound =
      wasHeld &&
      remembered !== undefined &&
      remembered.membership_epoch_id !== context.membership_epoch_id;
    this.#records.set(key, record);
    this.#contexts.set(key, context);
    const terminal = context.terminal_reason !== undefined;
    if (hold && !terminal) this.#held.add(key);
    else this.#held.delete(key);
    if (rebound && !terminal) {
      for (const listener of this.#unbindListeners) listener(record.ref);
    }
    if (
      (this.#held.has(key) || (wasHeld && terminal)) &&
      (!wasHeld ||
        rebound ||
        !previous ||
        previous.targetResidency !== record.targetResidency ||
        previous.terminalReason !== record.terminalReason ||
        remembered?.state_revision !== context.state_revision)
    ) {
      for (const listener of this.#listeners) listener(record);
    }
    let unheld = this.#records.size - this.#held.size;
    for (const candidate of this.#records.keys()) {
      if (unheld <= UNHELD_RECORD_LIMIT) break;
      if (candidate !== key && !this.#held.has(candidate)) {
        this.#forget(candidate);
        unheld--;
      }
    }
    return record;
  }

  #unbind(key: string, ref: Readonly<ExecutionContextRef>): void {
    this.#held.delete(key);
    this.#invalidate(key);
    this.#forget(key);
    for (const listener of this.#unbindListeners) listener(ref);
  }

  #forget(key: string): void {
    this.#held.delete(key);
    this.#invalidate(key);
    this.#records.delete(key);
    this.#contexts.delete(key);
  }

  #beginObservation(): number {
    const sequence = ++this.#observationSequence;
    this.#observations.add(sequence);
    return sequence;
  }

  #invalidate(key: string): void {
    this.#invalidations.set(key, ++this.#observationSequence);
    this.#pruneInvalidations();
  }

  #isCurrentObservation(key: string, sequence: number): boolean {
    return (this.#invalidations.get(key) ?? 0) <= sequence;
  }

  #endObservation(sequence: number): void {
    this.#observations.delete(sequence);
    this.#pruneInvalidations();
  }

  #pruneInvalidations(): void {
    // Retain tombstones only while a request predating them can still arrive.
    const oldest = this.#observations.size
      ? Math.min(...this.#observations)
      : Infinity;
    for (const [key, sequence] of this.#invalidations)
      if (sequence <= oldest) this.#invalidations.delete(key);
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new Error("TeamHub Execution Context store is closed");
  }
}

function isUnusedRoomContext(context: RuntimeContext): boolean {
  return (
    context.ref.kind === "meta" &&
    context.terminal_reason === undefined &&
    context.next_input_sequence === "0"
  );
}

function contextRecord(context: RuntimeContext): ExecutionContextRecord {
  const ref = fromWireRef(context.ref);
  const roomKind = context.room_kind;
  if (ref.kind === "meta") {
    if (roomKind !== "direct" && roomKind !== "collaboration")
      throw new Error("Meta Context is missing trusted Room kind");
  } else if (roomKind !== undefined)
    throw new Error("Room kind is allowed only for a Meta Context");
  const sharedTaskScope = contextSharedTaskScope(ref, context);
  return Object.freeze({
    ref: Object.freeze({ ...ref }),
    ...(roomKind === undefined ? {} : { roomKind }),
    ...(sharedTaskScope === undefined ? {} : { sharedTaskScope }),
    targetResidency: context.target_residency,
    ...(context.terminal_reason !== undefined
      ? { terminalReason: context.terminal_reason }
      : {}),
  });
}

function contextSharedTaskScope(
  ref: ExecutionContextRef,
  context: RuntimeContext,
): SharedTaskScope | undefined {
  const scope = context.shared_task_scope;
  if (scope === undefined) return undefined;
  const base = {
    version: 1,
    tenantId: scope.tenant_id,
    agentId: scope.agent_id,
    originRoomId: scope.origin_room_id,
  } as const;
  if (scope.agent_id !== ref.agentId || scope.tenant_id !== context.tenant_id)
    throw new Error("Shared Task scope does not match its Context");
  if (
    scope.role === "meta" &&
    ref.kind === "meta" &&
    "roomId" in ref &&
    scope.origin_room_id === ref.roomId &&
    scope.task_id === undefined
  )
    return Object.freeze({ ...base, role: "meta" });
  if (
    scope.role === "alter_ego" &&
    ref.kind === "alter_ego" &&
    scope.task_id === ref.taskId
  )
    return Object.freeze({ ...base, role: "alter_ego", taskId: ref.taskId });
  throw new Error("Shared Task scope does not match its Context");
}

/** The TeamHub wire shape of an Execution Context reference. */
export function toWireRef(ref: ExecutionContextRef): RuntimeContext["ref"] {
  if (ref.kind === "meta")
    return { kind: "meta", agent_id: ref.agentId, room_id: ref.roomId };
  if (ref.kind === "alter_ego")
    return { kind: "alter_ego", agent_id: ref.agentId, task_id: ref.taskId };
  return {
    kind: "document",
    agent_id: ref.agentId,
    document_id: ref.documentId,
  };
}

const fromWireRef = (ref: RuntimeContext["ref"]): ExecutionContextRef =>
  ref.kind === "meta"
    ? { kind: "meta", agentId: ref.agent_id, roomId: ref.room_id }
    : ref.kind === "alter_ego"
      ? { kind: "alter_ego", agentId: ref.agent_id, taskId: ref.task_id }
      : {
          kind: "document",
          agentId: ref.agent_id,
          documentId: ref.document_id,
        };

const assertResidency = (value: ContextTargetResidency): void => {
  if (value !== "active" && value !== "suspended") {
    throw new TypeError("targetResidency must be active or suspended");
  }
};

const isConflict = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  (error as { status?: unknown }).status === 409;
