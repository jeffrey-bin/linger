import { describe, expect, it } from "vitest";

import { DocumentAwarenessPolicy } from "../../src/document/realtime-awareness.js";
import type { RoomDocumentConnectionContext } from "../../src/document/realtime-session.js";
import {
  connectRealtimeClient,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

describe("Document awareness policy", () => {
  it("binds one client ID to the authenticated Actor and bounds state bytes", () => {
    const policy = new DocumentAwarenessPolicy();
    const connection = {};
    const state = { user: { color: "#0f766e", name: "Forged Name" } };
    policy.authorize({
      connection,
      context: context(),
      now: 1,
      removedClientIds: new Set(),
      states: new Map([[7, state]]),
    });
    expect(state.user).toEqual({
      actorId: "actor_human_1",
      color: "#0f766e",
      id: "actor_human_1",
      name: "actor_human_1",
    });

    const foreignConnection = {};
    policy.authorize({
      connection: foreignConnection,
      context: context(),
      now: 2,
      removedClientIds: new Set(),
      states: new Map([[8, { user: {} }]]),
    });
    const foreignState = new Map([[8, { user: {} }]]);
    policy.authorize({
      connection,
      context: context(),
      now: 3,
      removedClientIds: new Set(),
      states: foreignState,
    });
    expect(foreignState.size).toBe(0);
    const unexpectedLocalState = new Map([[9, { user: {} }]]);
    expect(() =>
      policy.authorize({
        connection,
        context: context(),
        now: 4,
        removedClientIds: new Set(),
        states: unexpectedLocalState,
      }),
    ).not.toThrow();
    expect(unexpectedLocalState.size).toBe(0);
    expect(() =>
      new DocumentAwarenessPolicy().authorize({
        connection: {},
        context: context(),
        removedClientIds: new Set(),
        states: new Map([[9, { cursor: "x".repeat(9 * 1024) }]]),
      }),
    ).toThrow("size limit");
  });

  it("filters remote awareness echoes and rejects unbound amplification", () => {
    const policy = new DocumentAwarenessPolicy();
    expect(() =>
      policy.authorize({
        connection: {},
        context: context(),
        removedClientIds: new Set(),
        states: new Map([
          [1, {}],
          [2, {}],
        ]),
      }),
    ).toThrow("multiple unbound client IDs");

    const boundConnection = {};
    policy.authorize({
      connection: boundConnection,
      context: context(),
      removedClientIds: new Set(),
      states: new Map([[3, {}]]),
    });
    const echoedConnection = {};
    policy.authorize({
      connection: echoedConnection,
      context: context(),
      removedClientIds: new Set(),
      states: new Map([[4, {}]]),
    });
    const echoedStates = new Map([
      [3, {}],
      [4, {}],
    ]);
    policy.authorize({
      connection: boundConnection,
      context: context(),
      removedClientIds: new Set(),
      states: echoedStates,
    });
    expect([...echoedStates.keys()]).toEqual([3]);

    const connection = {};
    for (let update = 0; update < 120; update += 1) {
      policy.authorize({
        connection,
        context: context(),
        now: update,
        removedClientIds: new Set(),
        states: new Map([[3, {}]]),
      });
    }
    expect(() =>
      policy.authorize({
        connection,
        context: context(),
        now: 120,
        removedClientIds: new Set(),
        states: new Map([[3, {}]]),
      }),
    ).toThrow("rate is too high");
  });

  it("scopes client ownership by Document and rejects foreign removals", () => {
    const policy = new DocumentAwarenessPolicy();
    const first = {};
    const second = {};
    policy.authorize({
      connection: first,
      context: context("document_1"),
      removedClientIds: new Set(),
      states: new Map([[7, {}]]),
    });
    policy.authorize({
      connection: second,
      context: context("document_2"),
      removedClientIds: new Set(),
      states: new Map([[7, {}]]),
    });

    const unknownRemovals = new Set([8]);
    expect(() =>
      policy.authorize({
        connection: second,
        context: context("document_2"),
        removedClientIds: unknownRemovals,
        states: new Map(),
      }),
    ).not.toThrow();
    expect(unknownRemovals.size).toBe(0);
    expect(() =>
      policy.authorize({
        connection: second,
        context: context("document_2"),
        removedClientIds: new Set([7]),
        states: new Map(),
      }),
    ).not.toThrow();
  });

  it("drops a stale removal before a reconnected client binds its local ID", () => {
    const policy = new DocumentAwarenessPolicy();
    const removedClientIds = new Set([7]);

    expect(() =>
      policy.authorize({
        connection: {},
        context: context(),
        removedClientIds,
        states: new Map(),
      }),
    ).not.toThrow();
    expect(removedClientIds.size).toBe(0);
  });

  it("broadcasts an explicit local awareness removal", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    const first = await connectRealtimeClient({
      token: "awareness_first",
      url: wsUrl(realtime.address),
    });
    const second = await connectRealtimeClient({
      token: "awareness_second",
      url: wsUrl(realtime.address),
    });

    try {
      first.provider.awareness!.setLocalState({ user: { color: "#0f766e" } });
      await waitFor(() =>
        second.provider.awareness!.getStates().has(first.document.clientID),
      );

      first.provider.awareness!.setLocalState(null);

      await waitFor(
        () =>
          !second.provider.awareness!.getStates().has(first.document.clientID),
      );
    } finally {
      first.provider.destroy();
      second.provider.destroy();
      await realtime.destroy();
    }
  });

  it("filters a foreign awareness removal without closing the sender or clearing the victim", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    const victim = await connectRealtimeClient({
      token: "awareness_victim",
      url: wsUrl(realtime.address),
    });
    const attacker = await connectRealtimeClient({
      token: "awareness_attacker",
      url: wsUrl(realtime.address),
    });
    const observer = await connectRealtimeClient({
      token: "awareness_observer",
      url: wsUrl(realtime.address),
    });

    try {
      victim.provider.awareness!.setLocalState({ user: {} });
      attacker.provider.awareness!.setLocalState({ user: {} });
      await waitFor(() =>
        observer.provider.awareness!.getStates().has(victim.document.clientID),
      );
      await waitFor(() =>
        attacker.provider.awareness!.getStates().has(victim.document.clientID),
      );

      removeRemoteAwarenessState(
        attacker.provider.awareness!,
        victim.document.clientID,
      );
      attacker.provider.awareness!.setLocalStateField("cursor", {
        anchor: 1,
      });
      await waitFor(
        () =>
          observer.provider
            .awareness!.getStates()
            .get(attacker.document.clientID)?.cursor !== undefined,
      );
      expect(
        observer.provider.awareness!.getStates().has(victim.document.clientID),
      ).toBe(true);
    } finally {
      victim.provider.destroy();
      attacker.provider.destroy();
      observer.provider.destroy();
      await realtime.destroy();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for awareness convergence");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function removeRemoteAwarenessState(
  awareness: NonNullable<
    Awaited<ReturnType<typeof connectRealtimeClient>>["provider"]["awareness"]
  >,
  clientId: number,
): void {
  if (!awareness.states.delete(clientId)) {
    throw new Error("Victim awareness state was not present on attacker");
  }
  const change = { added: [], updated: [], removed: [clientId] };
  awareness.emit("change", [change, "foreign-removal-test"]);
  awareness.emit("update", [change, "foreign-removal-test"]);
}

function context(documentId = "document_1"): RoomDocumentConnectionContext {
  return {
    admission: {
      signal: new AbortController().signal,
      markEstablished: () => undefined,
      promote: () => undefined,
      release: () => undefined,
      runRecovery: (operation) => operation(),
    },
    actorId: "actor_human_1",
    sessionId: "document_session_1",
    sessionExpiresAt: Date.now() + 60_000,
    schemaVersion: 1,
    disconnectMark: { document: 0, actor: 0, release: () => undefined },
    durableHead: {
      document_id: documentId,
      schema_version: 1,
      persisted_seq: 0,
      state_vector: "AA==",
      state_hash: "a".repeat(64),
      state_hash_version: 1,
    },
    canWrite: true,
  };
}
