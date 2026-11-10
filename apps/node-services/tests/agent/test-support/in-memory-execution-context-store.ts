import {
  encodeExecutionContextRef,
  type ExecutionContextKey,
} from "../../../src/agent/executor/context-ref.js";
import type {
  ContextTargetResidency,
  EnsureExecutionContextResult,
  ExecutionContextRecord,
  ExecutionContextStore,
} from "../../../src/agent/executor/context-ref.js";

export const createInMemoryExecutionContextStore = (): ExecutionContextStore =>
  new InMemoryExecutionContextStore();

class InMemoryExecutionContextStore implements ExecutionContextStore {
  readonly #records = new Map<ExecutionContextKey, ExecutionContextRecord>();
  #closed = false;

  async ensure(
    ref: ExecutionContextRecord["ref"],
    initialTargetResidency: ContextTargetResidency = "active",
  ): Promise<EnsureExecutionContextResult> {
    this.#assertOpen();
    assertResidency(initialTargetResidency);
    const key = encodeExecutionContextRef(ref);
    const existing = this.#records.get(key);
    if (existing) return { created: false, record: cloneRecord(existing) };
    const record = cloneRecord({
      ref,
      ...(ref.kind === "meta" ? { roomKind: "collaboration" as const } : {}),
      targetResidency: initialTargetResidency,
    });
    this.#records.set(key, record);
    return { created: true, record: cloneRecord(record) };
  }

  async get(
    ref: ExecutionContextRecord["ref"],
  ): Promise<ExecutionContextRecord | null> {
    this.#assertOpen();
    const record = this.#records.get(encodeExecutionContextRef(ref));
    return record ? cloneRecord(record) : null;
  }

  async list(): Promise<readonly ExecutionContextRecord[]> {
    this.#assertOpen();
    return [...this.#records.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, record]) => cloneRecord(record));
  }

  async listByAgent(
    agentId: string,
  ): Promise<readonly ExecutionContextRecord[]> {
    assertAgentId(agentId);
    return (await this.list()).filter(({ ref }) => ref.agentId === agentId);
  }

  async setTargetResidency(
    ref: ExecutionContextRecord["ref"],
    targetResidency: ContextTargetResidency,
  ): Promise<"updated" | "not_found"> {
    this.#assertOpen();
    assertResidency(targetResidency);
    const key = encodeExecutionContextRef(ref);
    const existing = this.#records.get(key);
    if (!existing) return "not_found";
    this.#records.set(
      key,
      cloneRecord({
        ref,
        ...(existing.roomKind === undefined
          ? {}
          : { roomKind: existing.roomKind }),
        targetResidency,
      }),
    );
    return "updated";
  }

  async remove(
    ref: ExecutionContextRecord["ref"],
  ): Promise<"removed" | "not_found"> {
    this.#assertOpen();
    return this.#records.delete(encodeExecutionContextRef(ref))
      ? "removed"
      : "not_found";
  }

  async removeByAgent(agentId: string): Promise<number> {
    this.#assertOpen();
    assertAgentId(agentId);
    let removed = 0;
    for (const [key, record] of this.#records) {
      if (record.ref.agentId !== agentId) continue;
      this.#records.delete(key);
      removed += 1;
    }
    return removed;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Execution Context store is closed");
  }
}

const cloneRecord = (
  record: ExecutionContextRecord,
): ExecutionContextRecord => ({
  ref: Object.freeze({ ...record.ref }),
  ...(record.roomKind === undefined ? {} : { roomKind: record.roomKind }),
  targetResidency: record.targetResidency,
});

const assertResidency = (value: ContextTargetResidency): void => {
  if (value !== "active" && value !== "suspended") {
    throw new TypeError("targetResidency must be active or suspended");
  }
};

const assertAgentId = (agentId: string): void => {
  if (!agentId) throw new TypeError("agentId must not be empty");
};
