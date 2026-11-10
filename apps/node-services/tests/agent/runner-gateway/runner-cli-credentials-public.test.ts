import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentCliCredentialFailed,
  AgentCliCredentialReport,
  AgentCliCredentialStored,
} from "@linger/wire-contracts/runner-gateway/types";
import { parseDaemonToAgentEnvelope } from "@linger/wire-contracts/runner-gateway/validator";
import {
  RunnerGateway,
  RunnerGatewayError,
  RunnerGatewayProtocolError,
  type RunnerGatewayConnection,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";

import {
  contextHello,
  authenticatedPrincipal,
  RecordingPeer,
  assignmentFence,
  placeAgent,
  defaultAgentPlacement,
  deferred,
  acknowledgeEnsuredAgent,
} from "./runner-gateway-fixtures.js";

describe("RunnerGateway Agent CLI credentials", () => {
  const tokenOf = (letter: string) => `th_agent_${letter.repeat(43)}`;
  const digestOf = (accessToken: string) =>
    createHash("sha256").update(accessToken).digest("hex");
  const placement = () =>
    defaultAgentPlacement({ workspaceGrantId: "grant-owner" });
  const credentialInput = (runnerRevision = 1) => ({
    computerId: "runner-local",
    tenantId: "tenant-acme",
    agentId: "agent-reviewer",
    runnerRevision,
    workspaceGrantId: "grant-owner",
  });
  // Issues th_agent_aaa…, th_agent_bbb…, each revoking the one before, and
  // confirms a held token while it is the live one.
  const fakeIssuer = (live?: string) => {
    let issued = 0;
    let current = live;
    return {
      profile: (identity: { tenantId: string; agentId: string }) => ({
        url: "https://teamhub.test",
        tenantId: identity.tenantId,
        agentId: identity.agentId,
      }),
      issue: vi.fn(
        async (
          _identity: unknown,
          _placement: unknown,
          heldSha256?: string,
        ): Promise<{ accessToken: string } | "current"> => {
          if (
            heldSha256 !== undefined &&
            current !== undefined &&
            heldSha256 === digestOf(current)
          )
            return "current";
          current = tokenOf(String.fromCharCode(97 + issued++));
          return { accessToken: current };
        },
      ),
    };
  };
  // What a Computer reports holding in agent_runner.ready. The default
  // placement is the Agent's first Runtime Assignment.
  const held = (
    accessToken: string,
    assignmentRevision = 1,
    url = "https://teamhub.test",
  ): AgentCliCredentialReport => ({
    sha256: digestOf(accessToken),
    assignment_revision: assignmentRevision,
    profile: {
      url,
      tenant_id: "tenant-acme",
      agent_id: "agent-reviewer",
    },
  });
  const acceptHolding = async (
    gateway: RunnerGateway,
    peer: RecordingPeer,
    credential?: AgentCliCredentialReport,
  ): Promise<RunnerGatewayConnection> => {
    placeAgent(gateway, placement());
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      contextHello(),
      peer,
    );
    await acknowledgeEnsuredAgent(connection, peer, true, credential);
    return connection;
  };
  const credentialPuts = (peer: RecordingPeer) =>
    peer.sent.filter(
      (envelope) =>
        envelope.type === "execute" && envelope.kind === "cli_credential",
    );
  const removeHoldingRunner = async (
    gateway: RunnerGateway,
    connection: RunnerGatewayConnection,
    peer: RecordingPeer,
  ) => {
    const removal = gateway.finalizeDeletedLocalAgentRunner(
      placement().agentId,
    );
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)?.type).toBe("agent_runner.remove"),
    );
    const remove = peer.sent.at(-1);
    if (remove?.type !== "agent_runner.remove")
      throw new Error("Expected agent_runner.remove");
    await connection.receive({
      type: "agent_runner.state",
      state: "removed",
      protocol_version: remove.protocol_version,
      command_id: remove.command_id,
      runner_id: remove.runner_id,
      ...assignmentFence(remove),
      tenant_id: remove.tenant_id,
      agent_id: remove.agent_id,
      connection_epoch: remove.connection_epoch,
      runner_revision: remove.runner_revision,
    });
    await removal;
  };
  const lastCredentialPut = (peer: RecordingPeer) => {
    const command = credentialPuts(peer).at(-1);
    if (command?.type !== "execute" || command?.kind !== "cli_credential")
      throw new Error("Expected agent_cli.credential.put");
    return command;
  };
  // The Daemon's reply; by default it stores the pushed credential.
  const storeLastPut = (
    connection: RunnerGatewayConnection,
    peer: RecordingPeer,
    options: { readonly sha256?: string } = {},
  ) => {
    const command = lastCredentialPut(peer);
    return connection.receive(
      parseDaemonToAgentEnvelope({
        type: "executed",
        kind: "cli_credential",
        outcome: "succeeded",
        protocol_version: command.protocol_version,
        command_id: command.command_id,
        runner_id: command.runner_id,
        tenant_id: command.tenant_id,
        agent_id: command.agent_id,
        ...assignmentFence(command),
        connection_epoch: command.connection_epoch,
        runner_revision: command.runner_revision,
        sha256: options.sha256 ?? digestOf(command.access_token),
      }),
    );
  };
  const refuseLastPut = (
    connection: RunnerGatewayConnection,
    peer: RecordingPeer,
    retryable: boolean,
  ) => {
    const command = lastCredentialPut(peer);
    return connection.receive(
      parseDaemonToAgentEnvelope({
        type: "executed",
        kind: "cli_credential",
        outcome: "failed",
        protocol_version: command.protocol_version,
        command_id: command.command_id,
        runner_id: command.runner_id,
        tenant_id: command.tenant_id,
        agent_id: command.agent_id,
        ...assignmentFence(command),
        connection_epoch: command.connection_epoch,
        runner_revision: command.runner_revision,
        error: {
          code: "AGENT_CLI_CREDENTIAL_FAILED",
          message: "TeamHub CLI credential command is invalid",
          retryable,
        },
      }),
    );
  };
  const credentialOutcome = (
    kind: "stored" | "failed",
    command: ReturnType<typeof lastCredentialPut>,
  ): AgentCliCredentialStored | AgentCliCredentialFailed => {
    const identity = {
      protocol_version: command.protocol_version,
      command_id: command.command_id,
      runner_id: command.runner_id,
      tenant_id: command.tenant_id,
      agent_id: command.agent_id,
      ...assignmentFence(command),
      connection_epoch: command.connection_epoch,
      runner_revision: command.runner_revision,
    };
    return kind === "stored"
      ? {
          ...identity,
          type: "executed",
          kind: "cli_credential",
          outcome: "succeeded",
          sha256: digestOf(command.access_token),
        }
      : {
          ...identity,
          type: "executed",
          kind: "cli_credential",
          outcome: "failed",
          error: {
            code: "AGENT_CLI_CREDENTIAL_FAILED",
            message: "TeamHub CLI credential command is invalid",
            retryable: false,
          },
        };
  };
  it("issues and pushes one credential when the Computer holds none", async () => {
    const issuer = fakeIssuer();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer);
    const pushing = gateway.ensureAgentCliCredential(credentialInput());
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
    expect(issuer.issue).toHaveBeenCalledOnce();
    expect(issuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-acme",
        agentId: "agent-reviewer",
      }),
      { computerId: "runner-local", workspaceGrantId: "grant-owner" },
      undefined,
    );
    expect(lastCredentialPut(peer)).toMatchObject({
      profile: {
        url: "https://teamhub.test",
        tenant_id: "tenant-acme",
        agent_id: "agent-reviewer",
      },
      access_token: tokenOf("a"),
      runner_revision: 1,
    });
    await storeLastPut(connection, peer);
    await expect(pushing).resolves.toBeUndefined();
    // The Computer now holds the Agent's credential for this assignment.
    await gateway.ensureAgentCliCredential(credentialInput());
    expect(issuer.issue).toHaveBeenCalledOnce();
    expect(credentialPuts(peer)).toHaveLength(1);
    connection.disconnect();
  });

  it("checks a reported live credential with TeamHub once per connection and sends nothing", async () => {
    const issuer = fakeIssuer(tokenOf("z"));
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer, held(tokenOf("z")));
    // Each Run and each steer asks again; only the first costs a request.
    await gateway.ensureAgentCliCredential(credentialInput());
    await gateway.ensureAgentCliCredential(credentialInput());
    expect(issuer.issue).toHaveBeenCalledOnce();
    expect(issuer.issue).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      digestOf(tokenOf("z")),
    );
    expect(credentialPuts(peer)).toEqual([]);
    connection.disconnect();
  });

  it("replaces a reported credential TeamHub no longer accepts", async () => {
    // The Computer holds a token TeamHub revoked: an operator revoked it, or
    // TeamHub issued the next one and the push never arrived.
    const issuer = fakeIssuer();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer, held(tokenOf("z")));
    const renewing = gateway.ensureAgentCliCredential(credentialInput());
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
    expect(lastCredentialPut(peer).access_token).toBe(tokenOf("a"));
    await storeLastPut(connection, peer);
    await expect(renewing).resolves.toBeUndefined();
    await gateway.ensureAgentCliCredential(credentialInput());
    expect(issuer.issue).toHaveBeenCalledOnce();
    connection.disconnect();
  });

  it.each([
    ["another Runtime Assignment", held(tokenOf("z"), 2)],
    [
      "another TeamHub CLI URL",
      held(tokenOf("z"), 1, "https://old.teamhub.test"),
    ],
  ])("replaces a reported credential of %s", async (_case, credential) => {
    const issuer = fakeIssuer();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer, credential);
    const renewing = gateway.ensureAgentCliCredential(credentialInput());
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
    await storeLastPut(connection, peer);
    await expect(renewing).resolves.toBeUndefined();
    expect(issuer.issue).toHaveBeenCalledOnce();
    connection.disconnect();
  });

  it("learns again from agent_runner.ready after the Computer reconnects", async () => {
    const issuer = fakeIssuer();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const first = new RecordingPeer();
    const connection = await acceptHolding(gateway, first);
    const pushing = gateway.ensureAgentCliCredential(credentialInput());
    await vi.waitFor(() => expect(credentialPuts(first)).toHaveLength(1));
    await storeLastPut(connection, first);
    await pushing;
    connection.disconnect();

    // The reconnected Computer reports the credential it stored.
    // It reports no Runner, so the Gateway ensures one at the next revision.
    const second = new RecordingPeer();
    const reconnected = await acceptHolding(
      gateway,
      second,
      held(tokenOf("a")),
    );
    // TeamHub confirms the reported token once; nothing is pushed.
    await gateway.ensureAgentCliCredential(credentialInput(2));
    await gateway.ensureAgentCliCredential(credentialInput(2));
    expect(issuer.issue).toHaveBeenCalledTimes(2);
    expect(credentialPuts(second)).toEqual([]);
    reconnected.disconnect();
  });

  it("rejects stale Runner revisions even when the credential is current", async () => {
    const issuer = fakeIssuer();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer, held(tokenOf("z")));
    await expect(
      gateway.ensureAgentCliCredential(credentialInput(2)),
    ).rejects.toBeInstanceOf(RunnerGatewayError);
    expect(issuer.issue).not.toHaveBeenCalled();
    expect(credentialPuts(peer)).toEqual([]);
    connection.disconnect();
  });

  it("does not send an old connection's issuance to a reconnected Computer", async () => {
    const issuer = fakeIssuer();
    const pending = deferred<{ accessToken: string }>();
    issuer.issue.mockReturnValueOnce(pending.promise);
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const first = new RecordingPeer();
    const connection = await acceptHolding(gateway, first);
    const issuing = gateway.ensureAgentCliCredential(credentialInput());
    connection.disconnect();
    const second = new RecordingPeer();
    const reconnected = await acceptHolding(
      gateway,
      second,
      held(tokenOf("z")),
    );
    pending.resolve({ accessToken: tokenOf("a") });
    await expect(issuing).rejects.toThrow("no longer current");
    expect(credentialPuts(first)).toEqual([]);
    expect(credentialPuts(second)).toEqual([]);
    // The lost issuance revoked the reported token, so TeamHub issues again.
    const renewing = gateway.ensureAgentCliCredential(credentialInput(2));
    await vi.waitFor(() => expect(credentialPuts(second)).toHaveLength(1));
    expect(issuer.issue).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      digestOf(tokenOf("z")),
    );
    await storeLastPut(reconnected, second);
    await expect(renewing).resolves.toBeUndefined();
    expect(issuer.issue).toHaveBeenCalledTimes(2);
    reconnected.disconnect();
  });

  it("starts a new issuance after re-placement while an old issuance is pending", async () => {
    const issuer = fakeIssuer();
    const pending = deferred<{ accessToken: string }>();
    issuer.issue.mockReturnValueOnce(pending.promise);
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer);
    const previous = gateway.ensureAgentCliCredential(credentialInput());
    await removeHoldingRunner(gateway, connection, peer);
    const placing = gateway.ensureReadyLocalAgentRunner({
      placement: {
        type: "local",
        tenantId: "tenant-acme",
        ownerActorId: "actor-alice",
        computerId: "runner-local",
        runtimeType: "codex",
        workspaceGrantId: "grant-owner",
        assignmentRevision: 1,
      },
      modelId: "codex-default",
      agentId: "agent-reviewer",
    });
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)?.type).toBe("agent_runner.ensure"),
    );
    await acknowledgeEnsuredAgent(connection, peer);
    const runnerRevision = await placing;
    const current = gateway.ensureAgentCliCredential(
      credentialInput(runnerRevision),
    );
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
    expect(issuer.issue).toHaveBeenCalledTimes(2);
    expect(lastCredentialPut(peer).runner_revision).toBe(runnerRevision);
    await storeLastPut(connection, peer);
    await current;
    pending.resolve({ accessToken: tokenOf("z") });
    await expect(previous).rejects.toBeInstanceOf(RunnerGatewayError);
    await gateway.ensureAgentCliCredential(credentialInput(runnerRevision));
    expect(issuer.issue).toHaveBeenCalledTimes(2);
    expect(credentialPuts(peer)).toHaveLength(1);
    connection.disconnect();
  });

  it("forgets the credential when its Agent Runner is removed and issues one for the next placement", async () => {
    const issuer = fakeIssuer();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer, held(tokenOf("z")));
    await removeHoldingRunner(gateway, connection, peer);
    // The Computer deleted the credential with its Runner.
    await expect(
      gateway.ensureAgentCliCredential(credentialInput()),
    ).rejects.toBeInstanceOf(RunnerGatewayError);
    expect(issuer.issue).not.toHaveBeenCalled();

    const placing = gateway.ensureReadyLocalAgentRunner({
      placement: {
        type: "local",
        tenantId: "tenant-acme",
        ownerActorId: "actor-alice",
        computerId: "runner-local",
        runtimeType: "codex",
        workspaceGrantId: "grant-owner",
        assignmentRevision: 1,
      },
      modelId: "codex-default",
      agentId: "agent-reviewer",
    });
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)?.type).toBe("agent_runner.ensure"),
    );
    await acknowledgeEnsuredAgent(connection, peer);
    const runnerRevision = await placing;
    const pushing = gateway.ensureAgentCliCredential(
      credentialInput(runnerRevision),
    );
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
    expect(lastCredentialPut(peer).runner_revision).toBe(runnerRevision);
    await storeLastPut(connection, peer);
    await expect(pushing).resolves.toBeUndefined();
    expect(issuer.issue).toHaveBeenCalledOnce();
    connection.disconnect();
  });

  it("shares one issuance between concurrent callers", async () => {
    const issuer = fakeIssuer();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer);
    const first = gateway.ensureAgentCliCredential(credentialInput());
    const second = gateway.ensureAgentCliCredential(credentialInput());
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
    await storeLastPut(connection, peer);
    await Promise.all([first, second]);
    expect(issuer.issue).toHaveBeenCalledOnce();
    expect(credentialPuts(peer)).toHaveLength(1);
    connection.disconnect();
  });

  it("cancels only the aborted caller's wait", async () => {
    const issuer = fakeIssuer();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer);
    const controller = new AbortController();
    const aborted = gateway.ensureAgentCliCredential({
      ...credentialInput(),
      signal: controller.signal,
    });
    const waiting = gateway.ensureAgentCliCredential(credentialInput());
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
    controller.abort(new Error("Run cancelled"));
    await expect(aborted).rejects.toThrow("Run cancelled");
    await storeLastPut(connection, peer);
    await expect(waiting).resolves.toBeUndefined();
    expect(credentialPuts(peer)).toHaveLength(1);
    connection.disconnect();
  });

  it("issues again on the next call after a refused push instead of keeping the revoked token", async () => {
    const issuer = fakeIssuer();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(
      gateway,
      peer,
      held(tokenOf("z"), 2),
    );
    const refused = gateway.ensureAgentCliCredential(credentialInput());
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
    await refuseLastPut(connection, peer, true);
    await expect(refused).rejects.toMatchObject({
      code: "AGENT_CLI_CREDENTIAL_FAILED",
    });
    const retried = gateway.ensureAgentCliCredential(credentialInput());
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(2));
    expect(lastCredentialPut(peer).access_token).toBe(tokenOf("b"));
    await storeLastPut(connection, peer);
    await expect(retried).resolves.toBeUndefined();
    expect(issuer.issue).toHaveBeenCalledTimes(2);
    connection.disconnect();
  });

  it("rejects with the issuance error when the Computer holds no usable credential", async () => {
    const issuer = fakeIssuer();
    issuer.issue.mockRejectedValueOnce(
      new Error("TeamHub CLI credential preparation failed (503)"),
    );
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(
      gateway,
      peer,
      held(tokenOf("z"), 2),
    );
    await expect(
      gateway.ensureAgentCliCredential(credentialInput()),
    ).rejects.toThrow("TeamHub CLI credential preparation failed (503)");
    expect(credentialPuts(peer)).toEqual([]);
    connection.disconnect();
  });

  it("rejects with the Daemon's fixed error and never includes the token", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: fakeIssuer(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer);
    const pushing = gateway.ensureAgentCliCredential(credentialInput());
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
    await refuseLastPut(connection, peer, false);
    const error = await pushing.catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "AGENT_CLI_CREDENTIAL_FAILED",
      retryable: false,
    });
    expect(String((error as Error).message)).not.toContain(tokenOf("a"));
    connection.disconnect();
  });

  it.each(
    (["stored", "failed"] as const).flatMap((kind) =>
      (
        [
          ["tenant_id", "tenant-other"],
          ["agent_id", "agent-other"],
          ["registration_id", "registration-other"],
          ["assignment_revision", 2],
          ["runner_revision", 2],
          ["connection_epoch", 2],
          ["runner_id", "runner-other"],
        ] as const
      ).map(([field, value]) => ({ kind, field, value })),
    ),
  )(
    "rejects a pending credential $kind receipt with a different $field",
    async ({ kind, field, value }) => {
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 60_000,
        agentCliCredentialIssuer: fakeIssuer(),
      });
      const peer = new RecordingPeer();
      const connection = await acceptHolding(gateway, peer);
      const pushing = gateway.ensureAgentCliCredential(credentialInput());
      const settled = pushing.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      try {
        await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
        const receipt = parseDaemonToAgentEnvelope({
          ...credentialOutcome(kind, lastCredentialPut(peer)),
          [field]: value,
        });
        await expect(connection.receive(receipt)).rejects.toBeInstanceOf(
          RunnerGatewayProtocolError,
        );
        expect(peer.closed).toContainEqual(
          expect.objectContaining({ code: 1002 }),
        );
        await expect(settled).resolves.toMatchObject({
          status: "rejected",
          error: expect.objectContaining({
            message: "Runner connection is no longer current",
          }),
        });
      } finally {
        connection.disconnect();
        await settled;
      }
    },
  );

  it.each(["stored", "failed"] as const)(
    "ignores a late credential %s receipt with an unknown command ID while the current push remains pending",
    async (kind) => {
      const issuer = fakeIssuer();
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 60_000,
        agentCliCredentialIssuer: issuer,
      });
      const peer = new RecordingPeer();
      const connection = await acceptHolding(gateway, peer);
      const pushing = gateway.ensureAgentCliCredential(credentialInput());
      let finished = false;
      const settled = pushing.then(
        () => {
          finished = true;
          return { status: "resolved" as const };
        },
        (error: unknown) => {
          finished = true;
          return { status: "rejected" as const, error };
        },
      );
      try {
        await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
        await connection.receive(
          parseDaemonToAgentEnvelope({
            ...credentialOutcome(kind, lastCredentialPut(peer)),
            command_id: "completed-credential-command",
          }),
        );
        expect(peer.closed).toEqual([]);
        expect(finished).toBe(false);
        if (kind === "stored") {
          await storeLastPut(connection, peer);
          await expect(settled).resolves.toEqual({ status: "resolved" });
        } else {
          await refuseLastPut(connection, peer, false);
          await expect(settled).resolves.toMatchObject({
            status: "rejected",
            error: { code: "AGENT_CLI_CREDENTIAL_FAILED" },
          });
        }
        expect(peer.closed).toEqual([]);
        expect(issuer.issue).toHaveBeenCalledOnce();
      } finally {
        connection.disconnect();
        await settled;
      }
    },
  );

  it("rejects a stored receipt for a token other than the pushed one", async () => {
    const issuer = fakeIssuer();
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: issuer,
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer);
    const pushing = gateway.ensureAgentCliCredential(credentialInput());
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
    await storeLastPut(connection, peer, { sha256: digestOf(tokenOf("z")) });
    const error = await pushing.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RunnerGatewayProtocolError);
    expect(String((error as Error).message)).not.toContain(tokenOf("a"));
    connection.disconnect();
  });

  it("rejects a pending push when the Computer disconnects", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      agentCliCredentialIssuer: fakeIssuer(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer);
    const pushing = gateway.ensureAgentCliCredential(credentialInput());
    await vi.waitFor(() => expect(credentialPuts(peer)).toHaveLength(1));
    connection.disconnect();
    await expect(pushing).rejects.toThrow();
  });

  it("refuses when no issuer is configured", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 60_000 });
    const peer = new RecordingPeer();
    const connection = await acceptHolding(gateway, peer);
    await expect(
      gateway.ensureAgentCliCredential(credentialInput()),
    ).rejects.toThrow("Agent CLI credential issuance is not configured");
    connection.disconnect();
  });
});
