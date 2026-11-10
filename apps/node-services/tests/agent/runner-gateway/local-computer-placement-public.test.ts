import { testComputerRelease } from "../test-support/runner-gateway.js";
import { describe, expect, it, vi } from "vitest";
import type { RunnerHello } from "@linger/wire-contracts/runner-gateway/types";
import {
  DEFAULT_LOCAL_RUNTIME_MODELS,
  LocalComputerOfflineError,
  LocalComputerPlacementError,
  LocalRuntimeAdmissionUnavailableError,
  MINIMUM_CURRENT_COMPUTER_VERSION,
  runtimeModelCatalogForComputer,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import {
  createTestRunnerGateway,
  testRegistryOf,
} from "../test-support/runner-gateway.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";
import { readyContextScope } from "../test-support/ready-context-view.js";

import {
  hello,
  contextHello,
  authenticatedPrincipal,
  RecordingPeer,
  assignmentFence,
  placeAgent,
  defaultAgentPlacement,
  acknowledgeEnsuredAgent,
  acceptReadyConnection,
} from "./runner-gateway-fixtures.js";

describe("RunnerGateway", () => {
  it("distinguishes an enrolled offline Computer from an invalid placement", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      hello(),
      new RecordingPeer(),
    );
    connection.disconnect();

    expect(() =>
      gateway.requireLocalPlacement(
        {
          type: "local",
          assignmentRevision: 1,
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          computerId: "runner-local",
          workspaceGrantId: "grant-repo",
          runtimeType: "codex",
        },
        "codex-default",
      ),
    ).toThrow(LocalComputerOfflineError);
  });

  it("waits when the Computer has no live connection", () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });

    expect(() =>
      gateway.requireLocalPlacement(
        {
          type: "local",
          assignmentRevision: 1,
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          computerId: "runner-local",
          workspaceGrantId: "grant-repo",
          runtimeType: "codex",
        },
        "codex-default",
      ),
    ).toThrow(LocalComputerOfflineError);
  });

  it("waits when the bound Runtime is not installed on a connected Computer", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const ready = vi.fn();
    gateway.subscribeLocalComputerReady(ready);
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello(),
        runtimes: ["pi"],
        runtime_diagnostics: runtimeDiagnostics({ ready: ["pi"] }),
        workspace_grants: [
          {
            grant_id: "grant-owner",
            tenant_id: "tenant-acme",
            label: "Linger managed workspace",
            mode: "workspace-write",
            scope: "owner",
          },
        ],
      },
      new RecordingPeer(),
    );
    expect(ready).toHaveBeenCalledTimes(1);

    const requirement = {
      type: "local" as const,
      assignmentRevision: 1,
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      computerId: "runner-local",
      workspaceGrantId: "grant-owner",
      runtimeType: "codex" as const,
    };
    expect(() =>
      gateway.requireLocalPlacement(requirement, "codex-default"),
    ).toThrow(LocalComputerOfflineError);
    expect(() =>
      gateway.requireLocalPlacement(requirement, "codex-default"),
    ).toThrow("Local Computer runtime is unavailable");
    expect(() =>
      gateway.requireLocalPlacement(requirement, "codex-default"),
    ).toThrow(LocalRuntimeAdmissionUnavailableError);
    expect(() =>
      gateway.requireLocalPlacement(
        { ...requirement, runtimeType: "pi", ownerActorId: "actor-bob" },
        "pi-default",
      ),
    ).toThrow(LocalComputerPlacementError);
    // A missing new-Run advertisement must not conceal revoked placement
    // from an active steer, which is allowed to defer diagnostic failures.
    expect(() =>
      gateway.requireLocalPlacement(
        { ...requirement, ownerActorId: "actor-bob" },
        "codex-default",
      ),
    ).toThrow(LocalComputerPlacementError);

    await connection.receive({
      type: "runner.runtime_diagnostics",
      protocol_version: "2",
      runner_id: "runner-local",
      sent_at: "2026-07-29T00:00:15.000Z",
      revision: 1,
      runtime_diagnostics: runtimeDiagnostics({ ready: ["codex", "pi"] }),
    });
    expect(ready).toHaveBeenCalledTimes(2);
    expect(() =>
      gateway.requireLocalPlacement(requirement, "codex-default"),
    ).not.toThrow();
    connection.disconnect();
  });

  it("retains a stopped Computer as offline and purges it only on explicit removal", async () => {
    const gateway = createTestRunnerGateway();
    const computerRegistry = testRegistryOf(gateway);
    computerRegistry.enroll({
      computerId: "runner-local",
      displayName: "Alice's Mac",
      ownerActorId: "actor-alice",
      tenantId: "tenant-acme",
    });
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello(),
        daemon_version: MINIMUM_CURRENT_COMPUTER_VERSION,
        platform: "win32",
        workspace_grants: [
          {
            grant_id: "grant-repo",
            tenant_id: "tenant-acme",
            label: "Linger workspace",
            mode: "workspace-write",
            scope: "owner",
          },
        ],
      },
      peer,
    );

    const owner = { tenantId: "tenant-acme", ownerActorId: "actor-alice" };
    // TeamHub lists what the Gateway recorded at hello.
    expect(computerRegistry.list(owner)).toMatchObject([
      {
        status: "online",
        daemonVersion: MINIMUM_CURRENT_COMPUTER_VERSION,
        platform: "win32",
        recommendedVersion: testComputerRelease.version,
      },
    ]);

    connection.disconnect();
    expect(computerRegistry.list(owner)).toMatchObject([
      { status: "offline", platform: "win32" },
    ]);

    await gateway.removeLocalComputer({
      computerId: "runner-local",
      ownerActorId: "actor-alice",
      tenantId: "tenant-acme",
    });
    expect(computerRegistry.list(owner)).toEqual([]);
  });

  it("serializes Computer deletion behind an in-flight Agent placement", async () => {
    const gateway = createTestRunnerGateway();
    const computerRegistry = testRegistryOf(gateway);
    computerRegistry.enroll({
      computerId: "runner-local",
      displayName: "Alice's Mac",
      ownerActorId: "actor-alice",
      tenantId: "tenant-acme",
    });
    let releasePlacement!: () => void;
    let placementEntered = false;
    const placement = gateway.runLocalComputerMutation(
      "runner-local",
      async () => {
        placementEntered = true;
        await new Promise<void>((resolve) => {
          releasePlacement = resolve;
        });
        placeAgent(gateway, defaultAgentPlacement());
      },
    );
    await vi.waitFor(() => expect(placementEntered).toBe(true));
    const deletion = gateway.runLocalComputerMutation(
      "runner-local",
      async () =>
        gateway.removeLocalComputer({
          computerId: "runner-local",
          ownerActorId: "actor-alice",
          tenantId: "tenant-acme",
        }),
    );

    await expect(
      Promise.race([
        deletion.then(
          () => "deleted",
          () => "rejected",
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("pending"), 20),
        ),
      ]),
    ).resolves.toBe("pending");
    releasePlacement();
    await placement;
    // The deletion runs after the placement and sees the placed Agent.
    await expect(deletion).rejects.toMatchObject({
      code: "local_computer_has_agents",
    });
  });

  it("retires a Computer with only historical Agent assignments", async () => {
    const gateway = createTestRunnerGateway();
    const computerRegistry = testRegistryOf(gateway);
    computerRegistry.enroll({
      computerId: "runner-local",
      displayName: "Alice's Mac",
      ownerActorId: "actor-alice",
      tenantId: "tenant-acme",
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer, {
      ...hello(),
      workspace_grants: [
        {
          grant_id: "grant-repo",
          tenant_id: "tenant-acme",
          label: "Linger workspace",
          mode: "workspace-write",
          scope: "owner",
        },
      ],
    });
    // TeamHub deleted the Agent's registration row.
    testRegistryOf(gateway).unplace(defaultAgentPlacement().agentId);
    const removal = gateway.finalizeDeletedLocalAgentRunner(
      defaultAgentPlacement().agentId,
    );
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)?.type).toBe("agent_runner.remove"),
    );
    const command = peer.sent.at(-1);
    if (command?.type !== "agent_runner.remove") {
      throw new Error("Expected agent_runner.remove");
    }
    await connection.receive({
      type: "agent_runner.state",
      state: "removed",
      protocol_version: command.protocol_version,
      command_id: command.command_id,
      runner_id: command.runner_id,
      ...assignmentFence(command),
      tenant_id: command.tenant_id,
      agent_id: command.agent_id,
      connection_epoch: command.connection_epoch,
      runner_revision: command.runner_revision,
    });
    await removal;
    const computer = {
      computerId: "runner-local",
      ownerActorId: "actor-alice",
      tenantId: "tenant-acme",
    };

    await expect(
      gateway.removeLocalComputer(computer),
    ).resolves.toBeUndefined();
    expect(computerRegistry.list(computer)).toEqual([]);
  });

  it("does not disclose assigned Agents to a different owner during removal", async () => {
    const gateway = createTestRunnerGateway();
    const computerRegistry = testRegistryOf(gateway);
    computerRegistry.enroll({
      computerId: "runner-local",
      displayName: "Alice's Mac",
      ownerActorId: "actor-alice",
      tenantId: "tenant-acme",
    });
    placeAgent(gateway, defaultAgentPlacement());

    await expect(
      gateway.removeLocalComputer({
        computerId: "runner-local",
        ownerActorId: "actor-mallory",
        tenantId: "tenant-acme",
      }),
    ).rejects.toThrow("Local Computer was not found");
    await expect(
      computerRegistry.credentialGeneration("runner-local", {
        ownerActorId: "actor-alice",
        tenantId: "tenant-acme",
      }),
    ).resolves.toBe(0);
  });

  it("projects only ready owner-scoped grants for the requested Human and Tenant", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
    });
    const peer = new RecordingPeer();
    await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello(),
        runtimes: ["codex", "claude"],
        runtime_diagnostics: runtimeDiagnostics({
          ready: ["codex", "claude"],
        }),
        workspace_grants: [
          {
            grant_id: "grant-owner",
            tenant_id: "tenant-acme",
            label: "Linger workspace",
            mode: "workspace-write",
            scope: "owner",
          },
          {
            grant_id: "grant-bound",
            tenant_id: "tenant-acme",
            label: "Existing Agent only",
            mode: "read-only",
            scope: "bindings",
          },
        ],
      },
      peer,
    );
    expect(() =>
      gateway.requireLocalPlacement(
        {
          type: "local",
          assignmentRevision: 1,
          tenantId: "tenant-acme",
          ownerActorId: "actor-bob",
          computerId: "runner-local",
          workspaceGrantId: "grant-owner",
          runtimeType: "claude",
        },
        "claude-default",
      ),
    ).toThrow("Local Computer is unavailable");
    expect(() =>
      gateway.requireLocalPlacement(
        {
          type: "local",
          assignmentRevision: 1,
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          computerId: "runner-local",
          workspaceGrantId: "grant-owner",
          runtimeType: "claude",
        },
        "claude-default",
      ),
    ).not.toThrow();
    await expect(
      gateway.startOperation({
        tenantId: "tenant-acme",
        ownerActorId: "actor-bob",
        runnerId: "runner-local",
        ...readyContextScope(),
        agentId: "agent-reviewer",
        workspaceGrantId: "grant-owner",
        request: {
          kind: "run.start",
          runtime: { type: "codex", model: "codex-default" },
          session_options: {
            thread_name: "Reviewer",
          },
          session: { threadId: "" },
          input: { type: "text", text: "hello" },
          run_context: { execution_run_ref: "run-1", source_inbox_ids: [] },
          run_resources: { mcp_servers: [] },
        },
      }),
    ).rejects.toThrow("Runner workspace grant is unavailable");
    await expect(
      gateway.startOperation({
        tenantId: "tenant-acme",
        ownerActorId: "actor-alice",
        runnerId: "runner-local",
        ...readyContextScope(),
        agentId: "agent-reviewer",
        workspaceGrantId: "grant-bound",
        request: {
          kind: "run.start",
          runtime: { type: "claude", model: "claude-default" },
          session_options: {
            thread_name: "Reviewer",
          },
          session: { threadId: "" },
          input: { type: "text", text: "hello" },
          run_context: { execution_run_ref: "run-1", source_inbox_ids: [] },
          run_resources: { mcp_servers: [] },
        },
      }),
    ).rejects.toThrow("Runner workspace grant is read-only");
    expect(peer.sent.some((frame) => frame.type === "operation.start")).toBe(
      false,
    );
  });

  it("carries each model's gateway context window into the catalog", () => {
    const greeting = hello();
    greeting.runtime_diagnostics = runtimeDiagnostics({ ready: ["codex"] });
    greeting.runtime_diagnostics.find(({ type }) => type === "codex")!.models =
      [
        {
          id: "qwen",
          label: "Qwen",
          allowed_reasoning_effort: [],
          context_window: 131_072,
        },
        { id: "gpt", label: "GPT", allowed_reasoning_effort: [] },
      ];
    expect(
      runtimeModelCatalogForComputer(greeting, DEFAULT_LOCAL_RUNTIME_MODELS)
        .codex,
    ).toEqual([
      {
        id: "qwen",
        label: "Qwen",
        runtimeModel: "qwen",
        allowedReasoningEffort: [],
        contextWindow: 131_072,
      },
      {
        id: "gpt",
        label: "GPT",
        runtimeModel: "gpt",
        allowedReasoningEffort: [],
      },
    ]);
  });

  it.each(["codex", "claude", "pi"] as const)(
    "keeps an authoritative empty %s catalog empty",
    async (runtimeType) => {
      const greeting = hello();
      greeting.workspace_grants = greeting.workspace_grants.map((grant) => ({
        ...grant,
        scope: "owner",
      }));
      greeting.runtimes = [runtimeType];
      greeting.runtime_diagnostics = runtimeDiagnostics({
        ready: [runtimeType],
      });
      for (const diagnostic of greeting.runtime_diagnostics)
        diagnostic.models = [];
      const catalog = runtimeModelCatalogForComputer(
        greeting,
        DEFAULT_LOCAL_RUNTIME_MODELS,
      );
      expect(catalog[runtimeType]).toEqual([]);
      const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1000 });
      const connection = await gateway.acceptConnection(
        authenticatedPrincipal(),
        greeting,
        new RecordingPeer(),
      );
      try {
        await expect(
          gateway.ensureReadyLocalAgentRunner({
            placement: {
              type: "local",
              tenantId: "tenant-acme",
              ownerActorId: "actor-alice",
              computerId: "runner-local",
              runtimeType,
              workspaceGrantId: "grant-repo",
              assignmentRevision: 1,
            },
            modelId: `${runtimeType}-default`,
            agentId: "agent-reviewer",
          }),
        ).rejects.toThrow("Local Computer model is unavailable");
      } finally {
        connection.disconnect();
      }
    },
  );

  it.each(["codex", "pi"] as const)(
    "projects an empty model list when the %s catalog is unavailable",
    async (runtimeType) => {
      const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
      const greeting = hello();
      greeting.runtimes = [];
      greeting.workspace_grants = greeting.workspace_grants.map((grant) => ({
        ...grant,
        scope: "owner" as const,
      }));
      greeting.runtime_diagnostics = runtimeDiagnostics({ ready: [] });
      for (const diagnostic of greeting.runtime_diagnostics) {
        diagnostic.models = [];
        if (diagnostic.type === runtimeType) {
          diagnostic.status = "error";
          diagnostic.model_catalog_error =
            "Configured Runtime model catalog is missing or unreadable";
          diagnostic.error = {
            code: "RUNTIME_DIAGNOSTIC_FAILED",
            message:
              "Configured Runtime model catalog is missing or unreadable",
          };
        }
      }
      await gateway.acceptConnection(
        authenticatedPrincipal(),
        greeting,
        new RecordingPeer(),
      );
      expect(
        runtimeModelCatalogForComputer(greeting, DEFAULT_LOCAL_RUNTIME_MODELS)[
          runtimeType
        ],
      ).toEqual([]);
    },
  );

  it("accepts a signed-out Pi and exposes real models after login", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const greeting = contextHello();
    greeting.runtimes = ["pi"];
    greeting.runtime_diagnostics = runtimeDiagnostics({ ready: [] });
    for (const diagnostic of greeting.runtime_diagnostics)
      diagnostic.models = [];
    greeting.runtime_diagnostics[2] = {
      type: "pi",
      status: "authentication_required",
      protocol: "rpc",
      checked_at: greeting.sent_at,
      models: [],
      error: {
        code: "RUNTIME_AUTHENTICATION_REQUIRED",
        message: "Sign in to Pi",
      },
    };
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      greeting,
      new RecordingPeer(),
    );
    expect(
      runtimeModelCatalogForComputer(greeting, DEFAULT_LOCAL_RUNTIME_MODELS).pi,
    ).toEqual([]);
    await connection.receive({
      type: "runner.runtime_diagnostics",
      protocol_version: "2",
      runner_id: greeting.runner_id,
      sent_at: "2026-07-29T00:00:15.000Z",
      revision: 2,
      runtime_diagnostics: [
        greeting.runtime_diagnostics[0],
        greeting.runtime_diagnostics[1],
        {
          type: "pi",
          status: "ready",
          protocol: "rpc",
          checked_at: "2026-07-29T00:00:15.000Z",
          models: [
            {
              id: "anthropic/pi-model",
              label: "Pi model",
              allowed_reasoning_effort: [],
            },
          ],
        },
      ],
    });
    connection.disconnect();
  });

  it.each([
    { length: 160, count: 1 },
    { length: 10, count: 100 },
  ])(
    "accepts the model catalog boundary $length/$count without adding undiscovered defaults",
    async ({ length, count }) => {
      const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
      const peer = new RecordingPeer();
      const models = Array.from({ length: count }, (_, index) => ({
        id: String(index).padEnd(length, "x"),
        label: "😀".repeat(length),
        allowed_reasoning_effort: [],
      }));
      const greeting = contextHello();
      for (const diagnostic of greeting.runtime_diagnostics) {
        diagnostic.models = diagnostic.type === "codex" ? models : [];
      }
      const connection = await gateway.acceptConnection(
        authenticatedPrincipal(),
        greeting,
        peer,
      );
      const runner = (modelId: string) => ({
        placement: {
          type: "local" as const,
          assignmentRevision: 1,
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          computerId: "runner-local",
          runtimeType: "codex" as const,
          workspaceGrantId: "grant-owner",
        },
        modelId,
        agentId: "agent-reviewer",
      });
      try {
        expect(peer.sent[0]).toMatchObject({ type: "runner.welcome" });
        const ensuring = gateway.ensureReadyLocalAgentRunner(
          runner(models[0]!.id),
        );
        await vi.waitFor(() =>
          expect(peer.sent.at(-1)).toMatchObject({
            type: "agent_runner.ensure",
            runtime: { type: "codex", model: models[0]!.id },
          }),
        );
        await acknowledgeEnsuredAgent(connection, peer);
        await expect(ensuring).resolves.toBe(1);
        await expect(
          gateway.ensureReadyLocalAgentRunner(runner("codex-default")),
        ).rejects.toThrow("unavailable");
      } finally {
        connection.disconnect();
      }
    },
  );

  it.each([
    { runtimeType: "claude", status: "ready" },
    { runtimeType: "claude", status: "authentication_required" },
    { runtimeType: "codex", status: "ready" },
  ] as const)(
    "accepts a $status $runtimeType default model without forwarding its alias",
    async ({ runtimeType, status }) => {
      const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
      const peer = new RecordingPeer();
      const modelId = `${runtimeType}-default`;
      const diagnostics = runtimeDiagnostics({
        ready: status === "ready" ? [runtimeType] : [],
        authenticationRequired:
          status === "authentication_required" ? [runtimeType] : [],
      });
      for (const diagnostic of diagnostics) {
        diagnostic.models =
          diagnostic.type === runtimeType
            ? [
                {
                  id: modelId,
                  label: "Runtime default",
                  allowed_reasoning_effort: [],
                },
              ]
            : [];
      }
      const connection = await gateway.acceptConnection(
        authenticatedPrincipal(),
        {
          ...hello(),
          runtimes: [runtimeType],
          runtime_diagnostics: diagnostics,
          workspace_grants: [
            {
              grant_id: "grant-owner",
              tenant_id: "tenant-acme",
              mode: "workspace-write",
              scope: "owner",
            },
          ],
        },
        peer,
      );
      try {
        expect(peer.sent[0]).toMatchObject({ type: "runner.welcome" });
        const ensuring = gateway.ensureReadyLocalAgentRunner({
          placement: {
            type: "local",
            tenantId: "tenant-acme",
            ownerActorId: "actor-alice",
            computerId: "runner-local",
            runtimeType,
            workspaceGrantId: "grant-owner",
            assignmentRevision: 1,
          },
          modelId,
          agentId: "agent-reviewer",
        });
        await vi.waitFor(() =>
          expect(peer.sent.at(-1)).toMatchObject({
            type: "agent_runner.ensure",
            runtime: { type: runtimeType },
          }),
        );
        expect(peer.sent.at(-1)).not.toHaveProperty("runtime.model");
        await acknowledgeEnsuredAgent(connection, peer);
        await expect(ensuring).resolves.toBe(1);
      } finally {
        connection.disconnect();
      }
    },
  );

  it("lists a connected Computer's Runtime models with its default", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const diagnostics = runtimeDiagnostics().map((diagnostic) =>
      diagnostic.type === "codex"
        ? {
            ...diagnostic,
            models: [
              {
                id: "gpt-6.1-sol",
                label: "GPT-6.1-Sol",
                allowed_reasoning_effort: ["low", "medium"] as const,
                context_window: 500_000,
                link: "subscription" as const,
                is_default: true,
              },
              {
                id: "qwen",
                label: "Qwen",
                allowed_reasoning_effort: [],
                context_window: 131_072,
                link: "subscription" as const,
              },
            ],
          }
        : { ...diagnostic, models: [] },
    ) as unknown as RunnerHello["runtime_diagnostics"];
    expect(gateway.runtimeModels("runner-local", "codex")).toBeUndefined();
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      { ...hello(), runtime_diagnostics: diagnostics },
      new RecordingPeer(),
    );
    expect(gateway.runtimeModels("runner-local", "codex")).toEqual([
      expect.objectContaining({
        id: "gpt-6.1-sol",
        contextWindow: 500_000,
        isDefault: true,
      }),
      expect.not.objectContaining({ isDefault: expect.anything() }),
    ]);
    expect(gateway.runtimeModels("runner-local", "claude")).toEqual([]);
    connection.disconnect();
    expect(gateway.runtimeModels("runner-local", "codex")).toBeUndefined();
  });

  it.each(["low", "xhigh"] as const)(
    "validates and prepares the selected Computer reasoning effort %s",
    async (reasoningEffort) => {
      const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
      const peer = new RecordingPeer();
      const diagnostics = runtimeDiagnostics().map((diagnostic) =>
        diagnostic.type === "codex"
          ? {
              ...diagnostic,
              models: [
                {
                  id: "gpt-6-astra",
                  label: "GPT-6-Astra",
                  allowed_reasoning_effort: ["low", "xhigh"] as const,
                  default_reasoning_effort: "low" as const,
                },
              ],
            }
          : { ...diagnostic, models: [] },
      ) as unknown as RunnerHello["runtime_diagnostics"];
      const connection = await gateway.acceptConnection(
        authenticatedPrincipal(),
        {
          ...hello(),
          runtime_diagnostics: diagnostics,
          workspace_grants: [
            {
              grant_id: "grant-owner",
              tenant_id: "tenant-acme",
              label: "Linger workspace",
              mode: "workspace-write",
              scope: "owner",
            },
          ],
        },
        peer,
      );
      expect(() =>
        gateway.requireLocalPlacement(
          {
            type: "local",
            assignmentRevision: 1,
            tenantId: "tenant-acme",
            ownerActorId: "actor-alice",
            computerId: "runner-local",
            runtimeType: "codex",
            workspaceGrantId: "grant-owner",
          },
          "gpt-6-astra",
          "ultra",
        ),
      ).toThrow("reasoning effort is unavailable");

      const requirement = {
        placement: {
          type: "local" as const,
          assignmentRevision: 1,
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          computerId: "runner-local",
          runtimeType: "codex" as const,
          workspaceGrantId: "grant-owner",
        },
        modelId: "gpt-6-astra",
        reasoningEffort,
        agentId: "agent-reviewer",
      };
      expect(() =>
        gateway.requireLocalPlacement(
          requirement.placement,
          requirement.modelId,
        ),
      ).toThrow("reasoning effort is unavailable");
      await expect(
        gateway.ensureReadyLocalAgentRunner({
          ...requirement,
          reasoningEffort: "ultra",
        }),
      ).rejects.toThrow("reasoning effort is unavailable");
      const readiness = gateway.ensureReadyLocalAgentRunner(requirement);
      await vi.waitFor(() =>
        expect(peer.sent.at(-1)).toMatchObject({
          type: "agent_runner.ensure",
          runtime: {
            type: "codex",
            model: "gpt-6-astra",
            reasoning_effort: reasoningEffort,
          },
        }),
      );
      await acknowledgeEnsuredAgent(connection, peer);
      await expect(readiness).resolves.toBe(1);
      connection.disconnect();
    },
  );

  it("runs without the reasoning effort when the Computer's model offers none", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const peer = new RecordingPeer();
    // An old Claude Code without --effort reports its models without levels.
    const diagnostics = runtimeDiagnostics().map((diagnostic) =>
      diagnostic.type === "codex"
        ? {
            ...diagnostic,
            models: [
              {
                id: "gpt-6-astra",
                label: "GPT-6-Astra",
                allowed_reasoning_effort: [],
              },
            ],
          }
        : { ...diagnostic, models: [] },
    ) as unknown as RunnerHello["runtime_diagnostics"];
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello(),
        runtime_diagnostics: diagnostics,
        workspace_grants: [
          {
            grant_id: "grant-owner",
            tenant_id: "tenant-acme",
            label: "Linger workspace",
            mode: "workspace-write",
            scope: "owner",
          },
        ],
      },
      peer,
    );
    const placement = {
      type: "local" as const,
      assignmentRevision: 1,
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      computerId: "runner-local",
      runtimeType: "codex" as const,
      workspaceGrantId: "grant-owner",
    };
    expect(() =>
      gateway.requireLocalPlacement(placement, "gpt-6-astra", "xhigh"),
    ).not.toThrow();
    const readiness = gateway.ensureReadyLocalAgentRunner({
      placement,
      modelId: "gpt-6-astra",
      reasoningEffort: "xhigh",
      agentId: "agent-reviewer",
    });
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "agent_runner.ensure",
        runtime: { type: "codex", model: "gpt-6-astra" },
      }),
    );
    expect(peer.sent.at(-1)).not.toHaveProperty("runtime.reasoning_effort");
    await acknowledgeEnsuredAgent(connection, peer);
    await expect(readiness).resolves.toBe(1);
    connection.disconnect();
  });

  it("maps a discovered Runtime default sentinel back to an omitted provider model", () => {
    const diagnostics = runtimeDiagnostics().map((diagnostic) => ({
      ...diagnostic,
      models:
        diagnostic.type === "codex"
          ? [
              {
                id: "codex-default",
                label: "Codex default",
                allowed_reasoning_effort: [],
              },
            ]
          : [],
    })) as unknown as RunnerHello["runtime_diagnostics"];
    const catalog = runtimeModelCatalogForComputer(
      {
        ...hello(),
        runtime_diagnostics: diagnostics,
      },
      DEFAULT_LOCAL_RUNTIME_MODELS,
    );

    expect(catalog.codex).toEqual([
      {
        id: "codex-default",
        label: "Codex default",
        allowedReasoningEffort: [],
      },
    ]);
  });

  it("gives Claude models on the signed-in account their built-in window", () => {
    const catalog = runtimeModelCatalogForComputer(
      {
        ...hello(),
        runtime_diagnostics: runtimeDiagnostics().map((entry) => ({
          ...entry,
          models:
            entry.type === "claude"
              ? [
                  { id: "opus", label: "Opus", link: "subscription" },
                  {
                    id: "claude-fable-5-1[1m]",
                    label: "Fable",
                    link: "subscription",
                  },
                  {
                    id: "sonnet",
                    label: "Sonnet",
                    link: "subscription",
                    context_window: 500_000,
                  },
                  { id: "gateway-model", label: "Gateway", link: "api" },
                ]
              : [],
        })) as RunnerHello["runtime_diagnostics"],
      },
      DEFAULT_LOCAL_RUNTIME_MODELS,
    );
    expect(
      catalog.claude.map(({ id, contextWindow }) => [id, contextWindow]),
    ).toEqual([
      ["opus", 200_000],
      ["claude-fable-5-1[1m]", 1_000_000],
      ["sonnet", 500_000],
      ["gateway-model", undefined],
    ]);
  });

  it("accepts a discovered model that has the same id as a legacy default", () => {
    const catalog = runtimeModelCatalogForComputer(
      {
        ...hello(),
        runtime_diagnostics: runtimeDiagnostics().map((entry) => ({
          ...entry,
          models:
            entry.type === "pi"
              ? [{ id: "pi-default", label: "Current Pi default" }]
              : [],
        })) as RunnerHello["runtime_diagnostics"],
      },
      DEFAULT_LOCAL_RUNTIME_MODELS,
    );
    expect(catalog.pi.filter((model) => model.id === "pi-default")).toEqual([
      expect.objectContaining({
        label: "Current Pi default",
      }),
    ]);
    expect(
      catalog.pi.find((model) => model.id === "pi-default"),
    ).not.toHaveProperty("runtimeModel");
  });
});
