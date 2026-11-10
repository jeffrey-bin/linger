import { fingerprintRoomDocumentDeletes } from "@linger/document-model";
import type { components as RuntimeComponents } from "@linger/wire-contracts/node-services-internal/types";
import * as Y from "yjs";

export type RoomDocumentSaveStatus =
  | "Connecting"
  | "Connection failed"
  | "Local pending"
  | "Offline"
  | "Synced"
  | "Saved"
  | "Offline pending";

export interface RoomDocumentSaveSnapshot {
  canEdit: boolean;
  durableHead?: RoomDocumentDurableHead;
  durableSequence?: number;
  protocolError?:
    | "durable_ack_conflict"
    | "durable_ack_invalid"
    | "durable_save_failed";
  status: RoomDocumentSaveStatus;
}

type DurableAckEnvelope = RuntimeComponents["schemas"]["DurableAckEnvelope"];
type DurabilityFailureEnvelope =
  RuntimeComponents["schemas"]["DurabilityFailureEnvelope"];
export type RoomDocumentDurableHead = DurableAckEnvelope["head"];
type DurableHead = RoomDocumentDurableHead;

export class RoomDocumentSaveTracker {
  readonly #document: Y.Doc;
  readonly #documentId: string;
  readonly #listeners = new Set<() => void>();
  readonly #schemaVersion: number;
  readonly #stateHashVersion: number;
  readonly #readOnly: boolean;
  #authenticationFailed = false;
  #connected = false;
  #connectionObserved = false;
  #durableHead?: DurableHead;
  #durableDeleteSetHash?: string;
  #localHydrated = false;
  #minimumDurableSequence = 0;
  #notificationScheduled = false;
  #protocolError?: RoomDocumentSaveSnapshot["protocolError"];
  #remoteHydrated = false;
  // Hocuspocus clears its synced flag on close without emitting an event, so
  // each connection must observe its own sync before the head counts as Saved.
  #remoteSynced = false;
  #snapshot: RoomDocumentSaveSnapshot = {
    canEdit: false,
    status: "Connecting",
  };
  #unacknowledgedLocalChanges = false;
  #unsyncedChanges = 0;

  constructor(input: {
    document: Y.Doc;
    documentId: string;
    schemaVersion: number;
    stateHashVersion: number;
    readOnly?: boolean;
  }) {
    this.#document = input.document;
    this.#documentId = input.documentId;
    this.#schemaVersion = input.schemaVersion;
    this.#stateHashVersion = input.stateHashVersion;
    this.#readOnly = input.readOnly ?? false;
    if (!this.#readOnly) {
      this.#document.on("afterTransaction", this.#afterTransaction);
    }
    this.#refresh();
  }

  markAuthenticationFailed(): void {
    this.#authenticationFailed = true;
    this.#refresh();
  }

  acceptDurableAck(value: unknown): boolean {
    if (!hasEnvelopeType(value, "durability_ack")) {
      return false;
    }
    if (!isDurableAckEnvelope(value)) {
      this.#setProtocolError("durable_ack_invalid");
      return false;
    }
    const head = value.head;
    if (
      head.document_id !== this.#documentId ||
      head.schema_version !== this.#schemaVersion ||
      head.state_hash_version !== this.#stateHashVersion
    ) {
      this.#setProtocolError("durable_ack_invalid");
      return false;
    }
    if (
      this.#durableHead !== undefined &&
      head.persisted_seq < this.#durableHead.persisted_seq
    ) {
      return false;
    }
    if (
      this.#durableHead !== undefined &&
      head.persisted_seq === this.#durableHead.persisted_seq
    ) {
      if (
        !sameHead(this.#durableHead, head) ||
        (this.#durableDeleteSetHash !== undefined &&
          value.delete_set_hash !== undefined &&
          this.#durableDeleteSetHash !== value.delete_set_hash)
      ) {
        this.#setProtocolError("durable_ack_conflict");
        return false;
      }
      this.#durableDeleteSetHash =
        value.delete_set_hash ?? this.#durableDeleteSetHash;
      this.#refresh();
      return true;
    }
    this.#durableDeleteSetHash = value.delete_set_hash;
    this.#durableHead = head;
    this.#refresh();
    return true;
  }

  acceptDurabilityFailure(value: unknown): boolean {
    if (!isDurabilityFailure(value) || value.document_id !== this.#documentId) {
      return false;
    }
    this.#setProtocolError("durable_save_failed");
    return true;
  }

  destroy(): void {
    if (!this.#readOnly) {
      this.#document.off("afterTransaction", this.#afterTransaction);
    }
    this.#listeners.clear();
  }

  getSnapshot = (): RoomDocumentSaveSnapshot => this.#snapshot;

  /** Whether this editor changed the Document since its last durable ACK. */
  hasUnsavedLocalChanges(): boolean {
    return (
      !this.#readOnly &&
      !this.#saved() &&
      (this.#unacknowledgedLocalChanges || this.#unsyncedChanges > 0)
    );
  }

  markLocalHydrated(): void {
    this.#localHydrated = true;
    this.#refresh();
  }

  markRemoteHydrated(): void {
    this.#remoteHydrated = true;
    this.#remoteSynced = true;
    this.#refresh();
  }

  setConnected(connected: boolean): void {
    this.#connectionObserved = true;
    this.#connected = connected;
    if (!connected) {
      this.#remoteSynced = false;
    }
    this.#refresh();
  }

  setUnsyncedChanges(count: number): void {
    this.#unsyncedChanges = Math.max(0, count);
    this.#refresh();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly #afterTransaction = (transaction: Y.Transaction) => {
    if (transaction.changedParentTypes.size === 0) {
      return;
    }
    if (transaction.local) {
      this.#unacknowledgedLocalChanges = true;
      this.#unsyncedChanges = Math.max(1, this.#unsyncedChanges);
    }
    if (this.#localHydrated && this.#remoteHydrated) {
      this.#minimumDurableSequence = Math.max(
        this.#minimumDurableSequence,
        (this.#durableHead?.persisted_seq ?? -1) + 1,
      );
    }
    this.#refresh();
  };

  #refresh(): void {
    const next = this.#deriveSnapshot();
    if (sameSnapshot(this.#snapshot, next)) {
      return;
    }
    this.#snapshot = next;
    if (!this.#notificationScheduled) {
      this.#notificationScheduled = true;
      queueMicrotask(this.#notifySubscribers);
    }
  }

  readonly #notifySubscribers = () => {
    this.#notificationScheduled = false;
    for (const listener of this.#listeners) {
      listener();
    }
  };

  #deriveSnapshot(): RoomDocumentSaveSnapshot {
    const durableSequence = this.#durableHead?.persisted_seq;
    const canEdit =
      !this.#authenticationFailed &&
      !this.#readOnly &&
      this.#protocolError === undefined &&
      this.#localHydrated &&
      this.#remoteHydrated &&
      this.#durableHead !== undefined;
    const shared = {
      canEdit,
      ...(durableSequence === undefined ? {} : { durableSequence }),
      ...(this.#protocolError === undefined
        ? {}
        : { protocolError: this.#protocolError }),
    };
    if (this.#authenticationFailed) {
      return { ...shared, canEdit: false, status: "Connection failed" };
    }
    if (this.#protocolError !== undefined) {
      return { ...shared, canEdit: false, status: "Synced" };
    }
    if (this.#readOnly) {
      if (!this.#connectionObserved) {
        return { ...shared, status: "Connecting" };
      }
      if (!this.#connected) {
        return { ...shared, status: "Offline" };
      }
      if (
        this.#localHydrated &&
        this.#remoteSynced &&
        this.#durableHead !== undefined
      ) {
        return {
          ...shared,
          durableHead: this.#durableHead,
          status: "Saved",
        };
      }
      return { ...shared, status: "Connecting" };
    }
    const saved = this.#saved();
    const hasPendingLocalChanges =
      !saved && (this.#unacknowledgedLocalChanges || this.#unsyncedChanges > 0);
    if (!this.#connectionObserved) {
      return { ...shared, status: "Connecting" };
    }
    if (!this.#connected) {
      return {
        ...shared,
        status: hasPendingLocalChanges ? "Offline pending" : "Offline",
      };
    }
    if (!canEdit) {
      return { ...shared, status: "Connecting" };
    }
    if (!this.#remoteSynced) {
      return {
        ...shared,
        status: hasPendingLocalChanges ? "Local pending" : "Connecting",
      };
    }
    if (saved) {
      return { ...shared, durableHead: this.#durableHead, status: "Saved" };
    }
    if (
      !this.#localHydrated ||
      !this.#remoteHydrated ||
      hasPendingLocalChanges
    ) {
      return { ...shared, status: "Local pending" };
    }
    return { ...shared, status: "Synced" };
  }

  #saved(): boolean {
    return (
      this.#localHydrated &&
      this.#remoteSynced &&
      this.#durableHead !== undefined &&
      this.#durableHead.persisted_seq >= this.#minimumDurableSequence &&
      localStateVectorMatchesHead(this.#document, this.#durableHead) &&
      this.#durableDeleteSetHash ===
        fingerprintRoomDocumentDeletes(this.#document)
    );
  }

  #setProtocolError(
    error: NonNullable<RoomDocumentSaveSnapshot["protocolError"]>,
  ): void {
    this.#protocolError = error;
    this.#refresh();
  }
}

function isDurabilityFailure(
  value: unknown,
): value is DurabilityFailureEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "durability_failure" &&
    typeof candidate.document_id === "string" &&
    typeof candidate.code === "string" &&
    [
      "append_rejected",
      "backlog_exceeded",
      "durability_invariant_failed",
    ].includes(candidate.code)
  );
}

function isDurableAckEnvelope(value: unknown): value is DurableAckEnvelope {
  return (
    hasEnvelopeType(value, "durability_ack") &&
    ((value as Record<string, unknown>).delete_set_hash === undefined ||
      (typeof (value as Record<string, unknown>).delete_set_hash === "string" &&
        /^[a-f0-9]{64}$/.test(
          (value as Record<string, unknown>).delete_set_hash as string,
        ))) &&
    isDurableHead((value as Record<string, unknown>).head)
  );
}

function hasEnvelopeType(value: unknown, type: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === type
  );
}

function isDurableHead(value: unknown): value is DurableHead {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const head = value as Partial<DurableHead>;
  return (
    typeof head.document_id === "string" &&
    Number.isInteger(head.persisted_seq) &&
    (head.persisted_seq ?? -1) >= 0 &&
    Number.isInteger(head.schema_version) &&
    typeof head.state_hash === "string" &&
    /^[a-f0-9]{64}$/.test(head.state_hash) &&
    Number.isInteger(head.state_hash_version) &&
    typeof head.state_vector === "string"
  );
}

function localStateVectorMatchesHead(
  document: Y.Doc,
  head: DurableHead,
): boolean {
  return bytesToBase64(Y.encodeStateVector(document)) === head.state_vector;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function sameHead(left: DurableHead, right: DurableHead): boolean {
  return (
    left.document_id === right.document_id &&
    left.persisted_seq === right.persisted_seq &&
    left.schema_version === right.schema_version &&
    left.state_hash === right.state_hash &&
    left.state_hash_version === right.state_hash_version &&
    left.state_vector === right.state_vector
  );
}

function sameSnapshot(
  left: RoomDocumentSaveSnapshot,
  right: RoomDocumentSaveSnapshot,
): boolean {
  return (
    sameOptionalHead(left.durableHead, right.durableHead) &&
    left.durableSequence === right.durableSequence &&
    left.canEdit === right.canEdit &&
    left.protocolError === right.protocolError &&
    left.status === right.status
  );
}

function sameOptionalHead(
  left: DurableHead | undefined,
  right: DurableHead | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameHead(left, right);
}
