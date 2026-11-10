import { describe, expect, it, vi } from "vitest";

import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";
import type { LocalRuntimeSettings } from "../../../src/agent/runtime-settings.js";
import {
  TeamHubRuntimeStateError,
  type RuntimeConfigSnapshot,
  type RuntimeDeletionSnapshot,
} from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import { createTeamHubGhostStore } from "../../../src/agent/executor/ghost-store.js";
import { createTeamHubRuntimeStateClientFake } from "../test-support/teamhub-runtime-state-client.js";

const wirePlacement = {
  tenant_id: "tenant-acme",
  owner_actor_id: "actor-owner",
  computer_id: "computer-a",
  runtime_type: "codex" as const,
  workspace_grant_id: "grant-a",
  assignment_revision: "1",
};

const localPlacement = {
  type: "local" as const,
  tenantId: "tenant-acme",
  ownerActorId: "actor-owner",
  computerId: "computer-a",
  runtimeType: "codex" as const,
  workspaceGrantId: "grant-a",
  assignmentRevision: 1,
};

const featureLogger: AgentLogger = {
  log: () => undefined,
  child: () => featureLogger,
};

const deletionSnapshot = (): RuntimeDeletionSnapshot => ({
  agent_id: "agent-reviewer",
  actor_id: "actor-reviewer",
  tenant_id: "tenant-acme",
  configuration_revision: "7",
  runtime: { type: "local", model: "fixture-model", placement: wirePlacement },
  contexts: [
    {
      context_key: '["meta","agent-reviewer","room","room-a"]',
      ref: { kind: "meta", agent_id: "agent-reviewer", room_id: "room-a" },
      agent_actor_id: "actor-reviewer",
      tenant_id: "tenant-acme",
      target_residency: "suspended",
      state_revision: "2",
      next_input_sequence: "0",
    },
  ],
});

describe("TeamHub deletion identity", () => {
  it("reads fresh cleanup identity without populating activation configuration", async () => {
    const getConfig = vi.fn(async () => {
      throw new TeamHubRuntimeStateError(404, "not materializable");
    });
    const getDeletionSnapshot = vi.fn(async () => deletionSnapshot());
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({
        getConfig,
        getDeletionSnapshot,
      }),
      listAgentIds: async () => [],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });
    await expect(store.getDeletionIdentity!("agent-reviewer")).resolves.toEqual(
      {
        agentId: "agent-reviewer",
        actorId: "actor-reviewer",
        tenantId: "tenant-acme",
        runtime: {
          type: "local",
          model: "fixture-model",
          placement: localPlacement,
        },
        contextRefs: [
          { kind: "meta", agentId: "agent-reviewer", roomId: "room-a" },
        ],
      },
    );
    await expect(store.get("agent-reviewer")).resolves.toBeNull();
    getDeletionSnapshot.mockRejectedValueOnce(
      new TeamHubRuntimeStateError(404, "no longer deleting"),
    );
    await expect(
      store.getDeletionIdentity!("agent-reviewer"),
    ).resolves.toBeNull();
    expect(getDeletionSnapshot).toHaveBeenCalledTimes(2);
    expect(getConfig).toHaveBeenCalledOnce();
    await store.close();
  });

  it.each([
    [
      "Agent",
      (value: RuntimeDeletionSnapshot) => {
        value.agent_id = "other-agent";
      },
    ],
    [
      "Tenant",
      (value: RuntimeDeletionSnapshot) => {
        value.contexts[0]!.tenant_id = "other-tenant";
      },
    ],
    [
      "Actor",
      (value: RuntimeDeletionSnapshot) => {
        value.contexts[0]!.agent_actor_id = "other-actor";
      },
    ],
    [
      "Context ref",
      (value: RuntimeDeletionSnapshot) => {
        value.contexts[0]!.ref = {
          kind: "meta",
          agent_id: "agent-reviewer",
          room_id: "room-1",
        };
      },
    ],
    [
      "duplicate Context",
      (value: RuntimeDeletionSnapshot) => {
        value.contexts.push(value.contexts[0]!);
      },
    ],
  ] as const)("rejects a mismatched %s", async (_name, corrupt) => {
    const snapshot = deletionSnapshot();
    corrupt(snapshot);
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({
        getDeletionSnapshot: async () => snapshot,
      }),
      listAgentIds: async () => [],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });
    await expect(store.getDeletionIdentity!("agent-reviewer")).rejects.toThrow(
      "identity does not match Agent",
    );
    await store.close();
  });

  it("propagates unavailable deletion authority instead of treating it as absence", async () => {
    const failure = new TeamHubRuntimeStateError(503, "unavailable");
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({
        getDeletionSnapshot: async () => {
          throw failure;
        },
      }),
      listAgentIds: async () => [],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });
    await expect(store.getDeletionIdentity!("agent-reviewer")).rejects.toBe(
      failure,
    );
    await store.close();
  });
});

describe("TeamHub Ghost projection", () => {
  it.each([403, 503])(
    "keeps a failed %s configuration visible while recovering other Agents",
    async (status) => {
      let unavailable = true;
      const failure = new TeamHubRuntimeStateError(
        status,
        "configuration unavailable",
      );
      const store = createTeamHubGhostStore({
        client: createTeamHubRuntimeStateClientFake({
          getConfig: async (agentId) => {
            if (agentId === "agent-a" && unavailable) throw failure;
            return {
              agent_id: agentId,
              actor_id: `actor:${agentId}`,
              tenant_id: "tenant-acme",
              configuration_revision: "1",
              runtime_configuration_revision: "1",
              content_hash: "a".repeat(64),
              permission_review: false,
              agent: { name: "Local", instructions: "Review." },
              runtime: {
                type: "local",
                model: "test-model",
                reasoning_effort: "low",
                placement: {
                  tenant_id: "tenant-acme",
                  owner_actor_id: "actor-owner",
                  computer_id: "computer-a",
                  runtime_type: "codex",
                  workspace_grant_id: "grant-a",
                  assignment_revision: "1",
                },
              },
              resources: { skills: [], mcp_servers: [] },
            };
          },
        }),
        listAgentIds: async () => ["agent-a", "agent-b"],
        parseRuntime: (value) => value as LocalRuntimeSettings,
      });
      const failures: string[] = [];
      const recover = () =>
        store.list(undefined, (agentId) => {
          failures.push(agentId);
        });
      try {
        // Partial inventory is allowed only when a recovery caller owns errors.
        await expect(store.list()).rejects.toBe(failure);
        await expect(recover()).resolves.toMatchObject([
          { agentId: "agent-b" },
        ]);
        expect(failures).toEqual(["agent-a"]);
        await expect(store.get("agent-a")).rejects.toBe(failure);
        unavailable = false;
        await expect(recover()).resolves.toMatchObject([
          { agentId: "agent-a" },
          { agentId: "agent-b" },
        ]);
        expect(failures).toEqual(["agent-a"]);
      } finally {
        await store.close();
      }
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "shares only pending opted-in refreshes and starts freshly after a %s read",
    async (failure) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let fail = true;
      const readError =
        failure === "cancelled"
          ? new DOMException("cancelled", "AbortError")
          : new Error("offline");
      const getConfig = vi.fn(async (agentId: string) => {
        await gate;
        if (fail) throw readError;
        return {
          agent_id: agentId,
          actor_id: `actor:${agentId}`,
          tenant_id: "tenant-acme",
          configuration_revision: "1",
          runtime_configuration_revision: "1",
          content_hash: "a".repeat(64),
          permission_review: false,
          agent: { name: "Reviewer", instructions: "Review." },
          runtime: {
            type: "local" as const,
            model: "gpt-5",
            placement: wirePlacement,
          },
          resources: { skills: [], mcp_servers: [] },
        };
      });
      const store = createTeamHubGhostStore({
        client: createTeamHubRuntimeStateClientFake({ getConfig }),
        listAgentIds: async () => [],
        parseRuntime: (value) => value as LocalRuntimeSettings,
      });
      const outcomes = Promise.allSettled(
        Array.from({ length: 8 }, () =>
          store.refresh!("agent-reviewer", { shareInFlight: true }),
        ),
      );
      const other = store.refresh!("agent-other", {
        shareInFlight: true,
      }).catch((error) => error);
      try {
        release();
        expect((await outcomes).map((result) => result.status)).toEqual(
          Array(8).fill("rejected"),
        );
        expect(await other).toBe(readError);
        expect(getConfig).toHaveBeenCalledTimes(2);
        fail = false;
        await expect(
          store.refresh!("agent-reviewer", { shareInFlight: true }),
        ).resolves.toEqual({ revision: "1", activationReady: true });
        expect(getConfig).toHaveBeenCalledTimes(3);
        await store.refresh!("agent-reviewer", { shareInFlight: true });
        expect(getConfig).toHaveBeenCalledTimes(4);
      } finally {
        release();
        await outcomes;
        await other;
        await store.close();
      }
    },
  );

  it.each([false, true])(
    "keeps exclusive refreshes independent when the older request shareability is %s",
    async (sharedFirst) => {
      const releases: Array<() => void> = [];
      let calls = 0;
      const getConfig = vi.fn(async () => {
        const revision = String(++calls);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return {
          agent_id: "agent-reviewer",
          actor_id: "actor-reviewer",
          tenant_id: "tenant-acme",
          configuration_revision: revision,
          runtime_configuration_revision: revision,
          content_hash: "a".repeat(64),
          permission_review: false,
          agent: { name: "Reviewer", instructions: "Review." },
          runtime: {
            type: "local" as const,
            model: "gpt-5",
            placement: wirePlacement,
          },
          resources: { skills: [], mcp_servers: [] },
        };
      });
      const store = createTeamHubGhostStore({
        client: createTeamHubRuntimeStateClientFake({ getConfig }),
        listAgentIds: async () => [],
        parseRuntime: (value) => value as LocalRuntimeSettings,
      });
      const first = store.refresh!("agent-reviewer", {
        shareInFlight: sharedFirst,
      });
      const second = store.refresh!("agent-reviewer", {
        shareInFlight: !sharedFirst,
      });
      try {
        await vi.waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2));
        releases[0]!();
        await expect(first).resolves.toBeUndefined();
        const joined = !sharedFirst
          ? store.refresh!("agent-reviewer", { shareInFlight: true })
          : undefined;
        releases[1]!();
        await expect(second).resolves.toEqual({
          revision: "2",
          activationReady: true,
        });
        if (joined)
          await expect(joined).resolves.toEqual({
            revision: "2",
            activationReady: true,
          });
        expect(getConfig).toHaveBeenCalledTimes(2);
        await expect(store.get("agent-reviewer")).resolves.toMatchObject({
          revision: "2",
        });
      } finally {
        releases.forEach((release) => release());
        await Promise.allSettled([first, second]);
        await store.close();
      }
    },
  );

  it("does not retain a pending refresh when the client throws synchronously", async () => {
    const getConfig = vi.fn(() => {
      throw new Error("synchronous failure");
    });
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({ getConfig }),
      listAgentIds: async () => [],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });
    try {
      await expect(
        store.refresh!("agent-reviewer", { shareInFlight: true }),
      ).rejects.toThrow("synchronous failure");
      await expect(
        store.refresh!("agent-reviewer", { shareInFlight: true }),
      ).rejects.toThrow("synchronous failure");
      expect(getConfig).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
    }
  });

  it("does not begin a deferred refresh after the store closes", async () => {
    const getConfig = vi.fn();
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({ getConfig }),
      listAgentIds: async () => [],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });
    const refresh = store.refresh!("agent-reviewer", { shareInFlight: true });
    const result = expect(refresh).rejects.toThrow(
      "TeamHub Ghost store is closed",
    );
    await store.close();
    await result;
    expect(getConfig).not.toHaveBeenCalled();
  });

  it("shares in-flight readiness reads but rechecks after completion and failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fail = false;
    let revision = "1";
    const getConfig = vi.fn(async (agentId: string) => {
      await gate;
      if (fail) throw new Error("unavailable");
      return {
        agent_id: agentId,
        actor_id: "actor-reviewer",
        tenant_id: "tenant-acme",
        configuration_revision: revision,
        runtime_configuration_revision: revision,
        content_hash: "a".repeat(64),
        permission_review: false,
        agent: { name: "Reviewer", instructions: "Review." },
        runtime: {
          type: "local" as const,
          model: "gpt-5",
          placement: wirePlacement,
        },
        resources: { skills: [], mcp_servers: [] },
      };
    });
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({ getConfig }),
      listAgentIds: async () => ["agent-reviewer"],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });
    try {
      const reads = Array.from({ length: 8 }, () =>
        store.isActivationReady!("agent-reviewer", "1"),
      );
      const stale = store.isActivationReady!("agent-reviewer", "2");
      const staleResult = expect(stale).rejects.toMatchObject({
        code: "agent_revision_conflict",
      });
      release();
      await expect(Promise.all(reads)).resolves.toEqual(Array(8).fill(true));
      await staleResult;
      expect(getConfig).toHaveBeenCalledTimes(1);
      revision = "2";
      await expect(
        store.isActivationReady!("agent-reviewer", "1"),
      ).rejects.toMatchObject({ code: "agent_revision_conflict" });
      expect(getConfig).toHaveBeenCalledTimes(2);
      fail = true;
      await expect(
        store.isActivationReady!("agent-reviewer", "2"),
      ).rejects.toThrow("unavailable");
      fail = false;
      await expect(
        store.isActivationReady!("agent-reviewer", "2"),
      ).resolves.toBe(true);
      expect(getConfig).toHaveBeenCalledTimes(4);
    } finally {
      release();
      await store.close();
    }
  });

  it("reads activation readiness freshly without replacing cached configuration", async () => {
    let revision = "1";
    const getConfig = vi.fn(async (agentId: string) => ({
      agent_id: agentId,
      actor_id: "actor-reviewer",
      tenant_id: "tenant-acme",
      configuration_revision: revision,
      runtime_configuration_revision: revision,
      content_hash: "a".repeat(64),
      permission_review: false,
      agent: { name: "Reviewer", instructions: "Review." },
      runtime: {
        type: "local" as const,
        model: "gpt-5",
        placement: wirePlacement,
      },
      resources: { skills: [], mcp_servers: [] },
    }));
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({ getConfig }),
      listAgentIds: async () => ["agent-reviewer"],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });
    await store.get("agent-reviewer");
    await expect(store.isActivationReady!("agent-reviewer", "1")).resolves.toBe(
      true,
    );
    revision = "2";
    await expect(
      store.isActivationReady!("agent-reviewer", "1"),
    ).rejects.toMatchObject({ code: "agent_revision_conflict" });
    await expect(store.isActivationReady!("agent-reviewer", "2")).resolves.toBe(
      true,
    );
    await expect(store.get("agent-reviewer")).resolves.toMatchObject({
      revision: "1",
      runtimeRevision: "1",
    });
    getConfig.mockRejectedValueOnce(
      Object.assign(new Error("deleted"), { status: 404 }),
    );
    await expect(
      store.isActivationReady!("agent-reviewer", "2"),
    ).rejects.toMatchObject({ code: "agent_activation_rejected" });
    getConfig.mockRejectedValueOnce(
      new TeamHubRuntimeStateError(503, "temporarily unavailable"),
    );
    await expect(
      store.isActivationReady!("agent-reviewer", "2"),
    ).rejects.toMatchObject({ code: "agent_activation_pending" });
    getConfig.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      store.isActivationReady!("agent-reviewer", "2"),
    ).rejects.toThrow("unavailable");
    await store.close();
  });

  it("refreshes a committed profile without a configuration callback", async () => {
    let revision = "1";
    const getConfig = vi.fn(async (agentId: string) => ({
      agent_id: agentId,
      actor_id: "actor-reviewer",
      tenant_id: "tenant-acme",
      configuration_revision: revision,
      runtime_configuration_revision: revision,
      content_hash: "a".repeat(64),
      permission_review: false,
      agent: {
        name: revision === "1" ? "Uninitialized" : "Reviewer",
        instructions: "Review.",
      },
      runtime: {
        type: "local" as const,
        model: "gpt-5",
        placement: wirePlacement,
      },
      resources: { skills: [], mcp_servers: [] },
    }));
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({ getConfig }),
      listAgentIds: async () => ["agent-reviewer"],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });
    await store.get("agent-reviewer");
    revision = "2";
    await expect(store.refresh!("agent-reviewer")).resolves.toEqual({
      revision: "2",
      activationReady: true,
    });
    expect(getConfig).toHaveBeenCalledTimes(2);
    await expect(store.get("agent-reviewer")).resolves.toMatchObject({
      revision: "2",
      agent: { name: "Reviewer" },
    });
    getConfig.mockRejectedValueOnce(
      new TeamHubRuntimeStateError(503, "offline"),
    );
    await expect(store.refresh!("agent-reviewer")).rejects.toThrow("offline");
    await expect(store.get("agent-reviewer")).resolves.toMatchObject({
      revision: "2",
    });
    await store.close();
  });

  it.each(["remove", "close", "new_refresh"] as const)(
    "invalidates an uncached pending refresh after %s",
    async (mutation) => {
      let revision = "1";
      let held = true;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let releaseNew!: () => void;
      const newGate = new Promise<void>((resolve) => {
        releaseNew = resolve;
      });
      const snapshot = () => ({
        agent_id: "agent-reviewer",
        actor_id: "actor-reviewer",
        tenant_id: "tenant-acme",
        configuration_revision: revision,
        runtime_configuration_revision: revision,
        content_hash: "a".repeat(64),
        permission_review: false,
        agent: { name: "Reviewer", instructions: "Review." },
        runtime: {
          type: "local" as const,
          model: "gpt-5",
          placement: wirePlacement,
        },
        resources: { skills: [], mcp_servers: [] },
      });
      const getConfig = vi.fn(async () => {
        const captured = snapshot();
        if (held) {
          held = false;
          await gate;
        } else if (mutation === "new_refresh") await newGate;
        return captured;
      });
      const store = createTeamHubGhostStore({
        client: createTeamHubRuntimeStateClientFake({ getConfig }),
        listAgentIds: async () => ["agent-reviewer"],
        parseRuntime: (value) => value as LocalRuntimeSettings,
      });
      const refreshing = store.refresh!("agent-reviewer", {
        shareInFlight: true,
      });
      const joined = store.refresh!("agent-reviewer", { shareInFlight: true });
      const joinedOutcome = joined.catch((error: unknown) => error);
      const outcome = refreshing.catch((error: unknown) => error);
      let newer: ReturnType<NonNullable<typeof store.refresh>> | undefined;
      try {
        // The mutation races an already dispatched HTTP response.
        await Promise.resolve();
        if (mutation === "remove") {
          await expect(
            store.insert({
              agentId: "agent-reviewer",
              actorId: "actor-reviewer",
              tenantId: "tenant-acme",
              revision: "1",
              agent: snapshot().agent,
              runtime: {
                type: "local",
                model: "gpt-5",
                placement: localPlacement,
              },
            }),
          ).resolves.toBe("inserted");
          await expect(store.remove("agent-reviewer")).resolves.toBe("removed");
        } else if (mutation === "close") {
          await store.close();
        } else {
          revision = "2";
          newer = store.refresh!("agent-reviewer");
        }
        release();
        if (mutation === "remove") {
          await expect(refreshing).resolves.toBeUndefined();
          await expect(joined).resolves.toBeUndefined();
          revision = "2";
          await expect(store.get("agent-reviewer")).resolves.toMatchObject({
            revision: "2",
          });
          expect(getConfig).toHaveBeenCalledTimes(3);
        } else if (mutation === "close") {
          await expect(refreshing).rejects.toThrow(
            "TeamHub Ghost store is closed",
          );
          await expect(joined).rejects.toThrow("TeamHub Ghost store is closed");
          await expect(
            store.refresh!("agent-reviewer", { shareInFlight: true }),
          ).rejects.toThrow("TeamHub Ghost store is closed");
        } else {
          await expect(refreshing).resolves.toBeUndefined();
          await expect(joined).resolves.toBeUndefined();
          releaseNew();
          await expect(newer).resolves.toEqual({
            revision: "2",
            activationReady: true,
          });
          await expect(store.get("agent-reviewer")).resolves.toMatchObject({
            revision: "2",
          });
        }
      } finally {
        release();
        releaseNew();
        await outcome;
        await joinedOutcome;
        await newer;
        await store.close();
      }
    },
  );

  it("lists only Agent IDs supplied by the claimed Context projection", async () => {
    const listContexts = vi.fn(async () => {
      throw new Error(
        "global Context listing must not drive Ghost restoration",
      );
    });
    const getConfig = vi.fn(async (agentId: string) => ({
      agent_id: agentId,
      actor_id: `actor-${agentId}`,
      tenant_id: "tenant-acme",
      configuration_revision: "1",
      runtime_configuration_revision: "1",
      content_hash: "a".repeat(64),
      permission_review: false,
      agent: { name: agentId, instructions: "Review the Room." },
      runtime: {
        type: "local" as const,
        model: "gpt-5",
        reasoning_effort: "xhigh" as const,
        placement: wirePlacement,
      },
      resources: { skills: [], mcp_servers: [] },
    }));
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({
        getConfig,
        listContexts,
      }),
      listAgentIds: async () => ["agent-writer", "agent-reviewer"],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });

    await expect(store.list()).resolves.toMatchObject([
      {
        agentId: "agent-reviewer",
        runtime: { model: "gpt-5", reasoningEffort: "xhigh" },
      },
      {
        agentId: "agent-writer",
        runtime: { model: "gpt-5", reasoningEffort: "xhigh" },
      },
    ]);
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(listContexts).not.toHaveBeenCalled();
    await store.close();
  });

  it("materializes a Local placement and compares registration structurally", async () => {
    const parseRuntime = vi.fn((value: unknown) => {
      expect(value).toMatchObject({
        type: "local",
        reasoningEffort: "xhigh",
        placement: {
          type: "local",
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          computerId: "runner-local",
          runtimeType: "codex",
          workspaceGrantId: "grant-repo",
        },
      });
      return value as LocalRuntimeSettings;
    });
    const store = createTeamHubGhostStore({
      parseRuntime,
      listAgentIds: async () => [],
      client: createTeamHubRuntimeStateClientFake({
        getConfig: async (agentId) => ({
          agent_id: agentId,
          actor_id: "actor-agent-reviewer",
          tenant_id: "tenant-acme",
          configuration_revision: "1",
          runtime_configuration_revision: "1",
          content_hash: "a".repeat(64),
          permission_review: false,
          agent: { name: "Reviewer", instructions: "Review the Room." },
          runtime: {
            type: "local",
            model: "gpt-6-astra",
            reasoning_effort: "xhigh",
            placement: {
              tenant_id: "tenant-acme",
              owner_actor_id: "actor-alice",
              computer_id: "runner-local",
              runtime_type: "codex",
              workspace_grant_id: "grant-repo",
              assignment_revision: "1",
            },
          },
          resources: { skills: [], mcp_servers: [] },
        }),
      }),
    });

    await expect(
      store.insert({
        agentId: "agent-reviewer",
        tenantId: "tenant-acme",
        revision: "1",
        resources: { skills: [], mcpServers: [] },
        agent: { name: "Reviewer", instructions: "Review the Room." },
        runtime: {
          type: "local",
          model: "gpt-6-astra",
          reasoningEffort: "xhigh",
          placement: {
            type: "local",
            tenantId: "tenant-acme",
            ownerActorId: "actor-alice",
            computerId: "runner-local",
            runtimeType: "codex",
            workspaceGrantId: "grant-repo",
            assignmentRevision: 1,
          },
        },
      }),
    ).resolves.toBe("inserted");
    expect(parseRuntime).toHaveBeenCalledOnce();
  });

  it("replaces a stale cached profile only with the current authoritative reservation", async () => {
    let revision = "1";
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({
        getConfig: async (agentId) => ({
          agent_id: agentId,
          actor_id: "actor-reviewer",
          tenant_id: "tenant-acme",
          configuration_revision: revision,
          runtime_configuration_revision: revision,
          content_hash: "a".repeat(64),
          permission_review: false,
          agent: { name: "Reviewer", instructions: "Review." },
          runtime: { type: "local", model: "gpt-5", placement: wirePlacement },
          resources: { skills: [], mcp_servers: [] },
        }),
      }),
      listAgentIds: async () => [],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });
    const cached = (await store.get("agent-reviewer"))!;
    revision = "3";
    const replacement = { ...cached, revision: "3" };
    await expect(
      store.replace!("agent-reviewer", "2", replacement),
    ).resolves.toBe("updated");
    await expect(
      store.replace!("agent-reviewer", "3", {
        ...replacement,
        agent: { name: "Forged", instructions: "Review." },
      }),
    ).resolves.toBe("revision_conflict");
    expect((await store.get("agent-reviewer"))!.agent.name).toBe("Reviewer");
    await store.close();
  });

  it("keeps the applied revision until the TeamHub update callback replaces it", async () => {
    let revision = "1";
    const client = createTeamHubRuntimeStateClientFake({
      getConfig: async (agentId, requestedRevision) => {
        const selected = requestedRevision ?? revision;
        if (selected !== revision) {
          throw Object.assign(new Error("revision conflict"), { status: 409 });
        }
        return {
          agent_id: agentId,
          actor_id: "actor-agent-reviewer",
          tenant_id: "tenant-acme",
          configuration_revision: revision,
          runtime_configuration_revision: revision,
          content_hash: revision.repeat(64),
          permission_review: false,
          agent: {
            name: `Reviewer ${revision}`,
            instructions: "Review the Room.",
          },
          runtime: {
            type: "local",
            model: `gpt-${revision}`,
            placement: wirePlacement,
          },
          resources: { skills: [], mcp_servers: [] },
        };
      },
    });
    const store = createTeamHubGhostStore({
      client,
      listAgentIds: async () => [],
      parseRuntime: (value) => value as LocalRuntimeSettings,
    });
    await expect(
      store.insert({
        agentId: "agent-reviewer",
        tenantId: "tenant-acme",
        revision: "1",
        resources: { skills: [], mcpServers: [] },
        agent: { name: "Reviewer 1", instructions: "Review the Room." },
        runtime: { type: "local", model: "gpt-1", placement: localPlacement },
      }),
    ).resolves.toBe("inserted");

    revision = "2";
    await expect(store.get("agent-reviewer")).resolves.toMatchObject({
      revision: "1",
    });
    const current = await store.get("agent-reviewer");
    expect(current).not.toBeNull();
    expect(store.replace).toBeDefined();
    await expect(
      store.replace!("agent-reviewer", "1", {
        ...current!,
        revision: "2",
        agent: { name: "Reviewer 2", instructions: "Review the Room." },
        runtime: { type: "local", model: "gpt-2", placement: localPlacement },
      }),
    ).resolves.toBe("updated");
    await expect(store.get("agent-reviewer")).resolves.toMatchObject({
      revision: "2",
      agent: { name: "Reviewer 2" },
    });
  });
});

describe("TeamHub Ghost missing registration cache", () => {
  const notFound = () =>
    new TeamHubRuntimeStateError(404, "not materializable");

  const readyConfig = (agentId: string): RuntimeConfigSnapshot => ({
    agent_id: agentId,
    actor_id: `actor:${agentId}`,
    tenant_id: "tenant-acme",
    configuration_revision: "1",
    runtime_configuration_revision: "1",
    content_hash: "a".repeat(64),
    permission_review: false,
    agent: { name: "Reviewer", instructions: "Review the Room." },
    runtime: {
      type: "local",
      model: "fixture-model",
      placement: wirePlacement,
    },
    resources: { skills: [], mcp_servers: [] },
  });

  it.each([true, false])(
    "carries TeamHub's permission judge into the Ghost (%s)",
    async (permissionReview) => {
      const store = createTeamHubGhostStore({
        client: createTeamHubRuntimeStateClientFake({
          getConfig: async (agentId: string) => ({
            ...readyConfig(agentId),
            permission_review: permissionReview,
          }),
        }),
        listAgentIds: async () => [],
        parseRuntime: (value) => value as LocalRuntimeSettings,
      });
      try {
        const ghost = await store.get("agent-reviewer");
        expect(ghost?.permissionReview).toBe(
          permissionReview ? true : undefined,
        );
        // A registration never carries the deployment fact.
        await expect(
          store.insert({
            agentId: "agent-reviewer",
            tenantId: "tenant-acme",
            revision: "1",
            resources: { skills: [], mcpServers: [] },
            agent: { name: "Reviewer", instructions: "Review the Room." },
            runtime: {
              type: "local",
              model: "fixture-model",
              placement: localPlacement,
            },
          }),
        ).resolves.toBe("inserted");
      } finally {
        await store.close();
      }
    },
  );

  it("suppresses repeated TeamHub reads for a 404 until the TTL expires", async () => {
    let now = 1_000;
    const getConfig = vi.fn(async () => {
      throw notFound();
    });
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({ getConfig }),
      listAgentIds: async () => [],
      parseRuntime: (value) => value as LocalRuntimeSettings,
      now: () => now,
    });
    try {
      await expect(store.get("agent-retired")).resolves.toBeNull();
      await expect(store.get("agent-retired")).resolves.toBeNull();
      expect(getConfig).toHaveBeenCalledTimes(1);

      now += 5 * 60 * 1000;
      await expect(store.get("agent-retired")).resolves.toBeNull();
      expect(getConfig).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
    }
  });

  it("lets insert replace a cached 404 with the current registration", async () => {
    let missing = true;
    const getConfig = vi.fn(async (agentId: string) => {
      if (missing) throw notFound();
      return readyConfig(agentId);
    });
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({ getConfig }),
      listAgentIds: async () => [],
      parseRuntime: (value) => value as LocalRuntimeSettings,
      now: () => 0,
    });
    try {
      await expect(store.get("agent-reviewer")).resolves.toBeNull();
      missing = false;
      await expect(
        store.insert({
          agentId: "agent-reviewer",
          tenantId: "tenant-acme",
          revision: "1",
          resources: { skills: [], mcpServers: [] },
          agent: { name: "Reviewer", instructions: "Review the Room." },
          runtime: {
            type: "local",
            model: "fixture-model",
            placement: localPlacement,
          },
        }),
      ).resolves.toBe("inserted");
      await expect(store.get("agent-reviewer")).resolves.toMatchObject({
        agentId: "agent-reviewer",
        revision: "1",
      });
      expect(getConfig).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
    }
  });

  it("does not cache non-404 failures", async () => {
    const failure = new TeamHubRuntimeStateError(503, "unavailable");
    const getConfig = vi.fn(async () => {
      throw failure;
    });
    const store = createTeamHubGhostStore({
      client: createTeamHubRuntimeStateClientFake({ getConfig }),
      listAgentIds: async () => [],
      parseRuntime: (value) => value as LocalRuntimeSettings,
      now: () => 0,
    });
    try {
      await expect(store.get("agent-a")).rejects.toBe(failure);
      await expect(store.get("agent-a")).rejects.toBe(failure);
      expect(getConfig).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
    }
  });
});
