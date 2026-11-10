import type { RoomDocumentConnectionContext } from "./realtime-session.js";

const awarenessWindowMs = 10_000;
const maxAwarenessUpdatesPerWindow = 120;
const maxAwarenessStateBytes = 8 * 1024;

interface AwarenessAdmission {
  clientId?: number;
  documentId: string;
  updates: number;
  windowStartedAt: number;
}

export class DocumentAwarenessPolicy {
  readonly #admissions = new WeakMap<object, AwarenessAdmission>();
  readonly #clientOwners = new Map<string, Map<number, object>>();

  authorize(input: {
    connection: object;
    context: RoomDocumentConnectionContext;
    now?: number;
    removedClientIds: Set<number>;
    states: Map<number, Record<string, unknown>>;
  }): void {
    const now = input.now ?? Date.now();
    const documentId = input.context.durableHead.document_id;
    let admission = this.#admissions.get(input.connection);
    if (
      admission === undefined ||
      now - admission.windowStartedAt >= awarenessWindowMs
    ) {
      admission = {
        clientId: admission?.clientId,
        documentId: admission?.documentId ?? documentId,
        updates: 0,
        windowStartedAt: now,
      };
      this.#admissions.set(input.connection, admission);
    }
    if (admission.documentId !== documentId) {
      throw new AwarenessPolicyError(
        "Document awareness connection changed Documents",
      );
    }
    admission.updates += 1;
    if (admission.updates > maxAwarenessUpdatesPerWindow) {
      throw new AwarenessPolicyError(
        "Document awareness update rate is too high",
      );
    }

    for (const clientId of [
      ...input.states.keys(),
      ...input.removedClientIds,
    ]) {
      if (!Number.isSafeInteger(clientId) || clientId < 0) {
        throw new AwarenessPolicyError(
          "Document awareness client ID is invalid",
        );
      }
    }
    const documentOwners = this.#clientOwners.get(documentId);
    for (const clientId of input.removedClientIds) {
      const owner = documentOwners?.get(clientId);
      if (owner === undefined) {
        input.removedClientIds.delete(clientId);
        continue;
      }
      if (admission.clientId !== clientId || owner !== input.connection) {
        input.removedClientIds.delete(clientId);
      }
    }
    const candidateIds = [...input.states.keys()].filter((clientId) => {
      const owner = documentOwners?.get(clientId);
      return owner === undefined || owner === input.connection;
    });
    if (admission.clientId === undefined) {
      if (candidateIds.length > 1) {
        throw new AwarenessPolicyError(
          "Document awareness update contains multiple unbound client IDs",
        );
      }
      if (candidateIds.length === 1) {
        admission.clientId = candidateIds[0];
        const owners = documentOwners ?? this.#createDocumentOwners(documentId);
        owners.set(candidateIds[0]!, input.connection);
      }
    } else {
      for (const clientId of candidateIds) {
        if (clientId !== admission.clientId) {
          input.states.delete(clientId);
        }
      }
    }
    for (const [clientId, state] of input.states) {
      if (admission.clientId === undefined || admission.clientId !== clientId) {
        input.states.delete(clientId);
        continue;
      }
      if (serializedBytes(state) > maxAwarenessStateBytes) {
        throw new AwarenessPolicyError(
          "Document awareness state exceeds its size limit",
        );
      }
      const user = readUserPresentation(state.user);
      state.user = {
        actorId: input.context.actorId,
        color: user.color,
        id: input.context.actorId,
        name: input.context.actorId,
      };
    }
  }

  release(connection: object): void {
    const admission = this.#admissions.get(connection);
    if (admission?.clientId !== undefined) {
      this.#releaseClientId(
        connection,
        admission.documentId,
        admission.clientId,
      );
    }
    this.#admissions.delete(connection);
  }

  #createDocumentOwners(documentId: string): Map<number, object> {
    const owners = new Map<number, object>();
    this.#clientOwners.set(documentId, owners);
    return owners;
  }

  #releaseClientId(
    connection: object,
    documentId: string,
    clientId: number,
  ): void {
    const owners = this.#clientOwners.get(documentId);
    if (owners?.get(clientId) === connection) {
      owners.delete(clientId);
      if (owners.size === 0) {
        this.#clientOwners.delete(documentId);
      }
    }
  }
}

export class AwarenessPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwarenessPolicyError";
  }
}

function serializedBytes(state: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(state));
  } catch {
    throw new AwarenessPolicyError("Document awareness state is invalid");
  }
}

function readUserPresentation(value: unknown): { color: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { color: "#64748b" };
  }
  const color = (value as Record<string, unknown>).color;
  return {
    color:
      typeof color === "string" && /^#[a-fA-F0-9]{6}$/.test(color)
        ? color
        : "#64748b",
  };
}
