import type { AgentId } from "./types.js";

export type TaskId = string;
export type DocumentId = string;

export interface MetaExecutionContextRef {
  readonly kind: "meta";
  readonly agentId: AgentId;
  readonly roomId: string;
}

export interface AlterEgoExecutionContextRef {
  readonly kind: "alter_ego";
  readonly agentId: AgentId;
  readonly taskId: TaskId;
}

export interface DocumentExecutionContextRef {
  readonly kind: "document";
  readonly agentId: AgentId;
  readonly documentId: DocumentId;
}

export type ExecutionContextRef =
  | MetaExecutionContextRef
  | AlterEgoExecutionContextRef
  | DocumentExecutionContextRef;

declare const executionContextKeyBrand: unique symbol;

export type ExecutionContextKey = string & {
  readonly [executionContextKeyBrand]: true;
};

export function assertExecutionContextRef(
  value: unknown,
): asserts value is ExecutionContextRef {
  if (!isPlainRecord(value)) {
    throw new TypeError("ExecutionContextRef must be an object");
  }
  if (value.kind === "meta") {
    assertExactKeys(
      value,
      ["kind", "agentId", "roomId"],
      "meta ExecutionContextRef",
    );
    assertNonEmptyId(value.agentId, "ExecutionContextRef.agentId");
    assertNonEmptyId(value.roomId, "ExecutionContextRef.roomId");
    return;
  }
  if (value.kind === "alter_ego") {
    assertExactKeys(
      value,
      ["kind", "agentId", "taskId"],
      "alter_ego ExecutionContextRef",
    );
    assertNonEmptyId(value.agentId, "ExecutionContextRef.agentId");
    assertNonEmptyId(value.taskId, "ExecutionContextRef.taskId");
    return;
  }
  if (value.kind === "document") {
    assertExactKeys(
      value,
      ["kind", "agentId", "documentId"],
      "document ExecutionContextRef",
    );
    assertNonEmptyId(value.agentId, "ExecutionContextRef.agentId");
    assertNonEmptyId(value.documentId, "ExecutionContextRef.documentId");
    return;
  }
  throw new TypeError(
    'ExecutionContextRef.kind must be "meta", "alter_ego", or "document"',
  );
}

export const encodeExecutionContextRef = (
  ref: ExecutionContextRef,
): ExecutionContextKey => {
  assertExecutionContextRef(ref);
  return JSON.stringify(
    ref.kind === "meta"
      ? ["meta", ref.agentId, "room", ref.roomId]
      : ref.kind === "alter_ego"
        ? ["alter_ego", ref.agentId, ref.taskId]
        : ["document", ref.agentId, ref.documentId],
  ) as ExecutionContextKey;
};

export const decodeExecutionContextKey = (
  key: string,
): Readonly<ExecutionContextRef> => {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("ExecutionContextKey must be a non-empty string");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(key) as unknown;
  } catch (error) {
    throw new TypeError("ExecutionContextKey must be valid JSON", {
      cause: error,
    });
  }

  let ref: ExecutionContextRef;
  if (
    Array.isArray(decoded) &&
    decoded.length === 4 &&
    decoded[0] === "meta" &&
    decoded[2] === "room"
  ) {
    assertNonEmptyId(decoded[1], "ExecutionContextKey agentId");
    assertNonEmptyId(decoded[3], "ExecutionContextKey roomId");
    ref = { kind: "meta", agentId: decoded[1], roomId: decoded[3] };
  } else if (
    Array.isArray(decoded) &&
    decoded.length === 3 &&
    decoded[0] === "alter_ego"
  ) {
    assertNonEmptyId(decoded[1], "ExecutionContextKey agentId");
    assertNonEmptyId(decoded[2], "ExecutionContextKey taskId");
    ref = {
      kind: "alter_ego",
      agentId: decoded[1],
      taskId: decoded[2],
    };
  } else if (
    Array.isArray(decoded) &&
    decoded.length === 3 &&
    decoded[0] === "document"
  ) {
    assertNonEmptyId(decoded[1], "ExecutionContextKey agentId");
    assertNonEmptyId(decoded[2], "ExecutionContextKey documentId");
    ref = {
      kind: "document",
      agentId: decoded[1],
      documentId: decoded[2],
    };
  } else {
    throw new TypeError("ExecutionContextKey has an unsupported shape");
  }

  if (encodeExecutionContextRef(ref) !== key) {
    throw new TypeError("ExecutionContextKey is not canonical");
  }
  return Object.freeze(ref);
};

function assertNonEmptyId(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

const assertExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void => {
  const allowed = new Set(expected);
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw new TypeError(`${field}.${unknownKey} is not supported`);
  }
  const missingKey = expected.find((key) => !Object.hasOwn(value, key));
  if (missingKey !== undefined) {
    throw new TypeError(`${field}.${missingKey} is required`);
  }
};

// A plain object only: unlike service-kit isRecord, class instances are refused.
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
};

export type ContextTargetResidency = "active" | "suspended";
export type MetaRoomKind = "direct" | "collaboration";

/**
 * TeamHub-trusted identity of the shared Task directory a Context reads
 * (Room Meta) or writes (alter_ego of a Meta-coordinated Task).
 */
export type SharedTaskScope =
  | {
      readonly version: 1;
      readonly tenantId: string;
      readonly agentId: string;
      readonly originRoomId: string;
      readonly role: "meta";
    }
  | {
      readonly version: 1;
      readonly tenantId: string;
      readonly agentId: string;
      readonly originRoomId: string;
      readonly role: "alter_ego";
      readonly taskId: string;
    };

export interface ExecutionContextRecord {
  readonly ref: ExecutionContextRef;
  readonly roomKind?: MetaRoomKind;
  readonly sharedTaskScope?: SharedTaskScope;
  readonly targetResidency: ContextTargetResidency;
  readonly terminalReason?: "room_deleted" | "context_deleted";
}

export interface EnsureExecutionContextResult {
  readonly created: boolean;
  readonly record: ExecutionContextRecord;
}

export interface ExecutionContextStore {
  ensure(
    ref: ExecutionContextRef,
    initialTargetResidency?: ContextTargetResidency,
  ): Promise<EnsureExecutionContextResult>;
  get(ref: ExecutionContextRef): Promise<ExecutionContextRecord | null>;
  list(): Promise<readonly ExecutionContextRecord[]>;
  listByAgent(agentId: string): Promise<readonly ExecutionContextRecord[]>;
  setTargetResidency(
    ref: ExecutionContextRef,
    targetResidency: ContextTargetResidency,
  ): Promise<"updated" | "not_found">;
  remove(ref: ExecutionContextRef): Promise<"removed" | "not_found">;
  removeByAgent(agentId: string): Promise<number>;
  subscribe?(
    listener: (record: Readonly<ExecutionContextRecord>) => void,
  ): () => void;
  /**
   * The record this store last observed, without a read. A store that
   * publishes through subscribe() keeps it current with every notification.
   */
  cached?(ref: ExecutionContextRef): Readonly<ExecutionContextRecord> | null;
  /**
   * Notifies lifecycle owners when this process stops holding a Context or
   * TeamHub rebinds it to a new Room membership; what was prepared for it
   * must stop.
   */
  subscribeUnbind?(
    listener: (ref: Readonly<ExecutionContextRef>) => void,
  ): () => void;
  /** Stops holding a suspended Context; queued work binds it again. */
  releaseIfIdle?(ref: ExecutionContextRef): Promise<boolean>;
  close(): Promise<void>;
}
