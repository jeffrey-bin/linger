import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { components } from "@linger/wire-contracts/teamhub-internal/types";
import { expect, it } from "vitest";
import {
  createTeamHubAgentResourcesResolver,
  createTeamHubMcpContextResolver,
} from "../../../src/agent/executor/teamhub-context-resolvers.js";

it("resolves the real Stage C fixture through the Agent consumer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stage-c-resolver-"));
  const inboxStateFile = path.join(directory, "inbox-state.json");
  const snapshot = {
    tenant_id: "tenant-fixture",
    inboxes: [
      {
        inbox_id: "room:room-fixture",
        kind: "room",
        room_id: "room-fixture",
        actor_ids: ["actor-agent-fixture"],
        messages: [],
      },
    ],
    documents: [
      {
        id: "document_fixture_input",
        inbox_id: "room:room-fixture",
        filename: "input.txt",
        content: "AUTHORIZED_CLI_INPUT\n",
      },
    ],
  };
  await writeFile(inboxStateFile, JSON.stringify(snapshot));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  // The fixture writes its ready file from the listen callback; watch for it
  // instead of polling /health against a wall-clock budget.
  const readyWatcher = watch(directory);
  const child = spawn(
    process.execPath,
    [
      path.join(
        import.meta.dirname,
        "local-runner-stage-c-teamhub-fixture.mjs",
      ),
      "--port",
      String(port),
      "--ready-file",
      path.join(directory, "ready"),
      "--report-file",
      path.join(directory, "events"),
      "--artifact-directory",
      path.join(directory, "artifacts"),
      "--service-token",
      "fixture-service",
      "--tenant-id",
      "tenant-fixture",
      "--inbox-state-file",
      inboxStateFile,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (value: string) => {
    stderr += value;
  });
  const post = async (route: string, body: unknown) => {
    const response = await fetch(origin + route, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-service",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const ready = new Promise<void>((resolve, reject) => {
    readyWatcher.on("change", (_event, filename) => {
      if (filename === "ready") resolve();
    });
    readyWatcher.once("error", reject);
    child.once("close", () => reject(new Error(stderr)));
  });
  try {
    await ready;
    expect((await fetch(origin + "/health")).ok).toBe(true);
    const retiredDraft = await fetch(
      origin + "/v0/rooms/room-fixture/agents/agent-fixture/message-drafts",
      {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-service",
          "content-type": "application/json",
          "idempotency-key": "retired-draft",
        },
        body: JSON.stringify({ message_kind: "agent_status" }),
      },
    );
    expect(retiredDraft.status).toBe(404);
    const resources = await createTeamHubAgentResourcesResolver({
      baseUrl: origin,
      serviceToken: "fixture-service",
    }).resolve({
      agentId: "agent-fixture",
      signal: new AbortController().signal,
    });
    expect(resources.skills[0]).toMatchObject({ skillId: "skill-stage-c" });
    const resolver = createTeamHubMcpContextResolver({
      resolveContext: (request) =>
        post(
          `/internal/agents/${request.agentId}/mcp-context/actions/resolve`,
          { context: request.context },
        ),
    });
    await expect(
      resolver.resolve({
        ref: { kind: "meta", agentId: "agent-fixture", roomId: "room-fixture" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({});
    await post("/__test__/runtime-configs", {
      registration: {
        agentId: "agent-fixture",
        tenantId: "tenant-fixture",
        revision: "1",
        agent: { name: "Fixture Agent", instructions: "Test only" },
        runtime: {
          model: "fixture",
          placement: {
            type: "local",
            tenantId: "tenant-fixture",
            ownerActorId: "human-fixture",
            computerId: "computer-fixture",
            runtimeType: "codex",
            workspaceGrantId: "grant-fixture",
          },
        },
        resources: { skills: [], mcpServers: [] },
      },
    });
    const registrations = (await (
      await fetch(origin + "/v0/agent-runtime/local-runtime-registrations", {
        headers: { authorization: "Bearer fixture-service" },
      })
    ).json()) as { registrations: { registration_id: string }[] };
    const registrationId = registrations.registrations[0]!.registration_id;
    await post("/v0/agent-runtime/assignments/set", {
      agent_management_id: "agent-fixture",
      agent_actor_id: "actor-agent-fixture",
      tenant_id: "tenant-fixture",
      registration_id: registrationId,
      expected_revision: "0",
      state: "bound",
    });
    const credentialResponse = await fetch(
      origin + "/internal/agents/agent-fixture/access-credentials",
      {
        method: "POST",
        headers: { authorization: "Bearer fixture-service" },
        body: JSON.stringify({
          label: "Stage C",
        }),
      },
    );
    expect(credentialResponse.status).toBe(201);
    const credential = (await credentialResponse.json()) as {
      access_token: string;
    };
    // Business permission comes from current membership, independently of MCP.
    const fileHeaders = {
      authorization: `Bearer ${credential.access_token}`,
      "x-teamhub-context-kind": "room",
      "x-teamhub-context-id": "room-fixture",
    };
    const inputFile = await fetch(
      origin + "/api/agent/v1/files/document_fixture_input/content",
      { headers: fileHeaders },
    );
    expect(inputFile.status).toBe(200);
    expect(inputFile.headers.get("x-document-filename")).toBe(
      Buffer.from("input.txt").toString("base64url"),
    );
    expect(inputFile.headers.get("cache-control")).toBe("private, no-store");
    expect(await inputFile.text()).toBe("AUTHORIZED_CLI_INPUT\n");
    snapshot.inboxes[0]!.actor_ids = [];
    await writeFile(inboxStateFile, JSON.stringify(snapshot));
    expect(
      (
        await fetch(
          origin + "/api/agent/v1/files/document_fixture_input/content",
          { headers: fileHeaders },
        )
      ).status,
    ).toBe(403);
    snapshot.inboxes[0]!.actor_ids = ["actor-agent-fixture"];
    await writeFile(inboxStateFile, JSON.stringify(snapshot));
    const message = await fetch(origin + "/api/agent/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.access_token}`,
        "content-type": "application/json",
        "x-teamhub-context-kind": "room",
        "x-teamhub-context-id": "room-fixture",
        "x-teamhub-operation-id": "fixture-message",
      },
      body: JSON.stringify({
        inbox_id: "room:room-fixture",
        message_segments: [{ type: "text", content: "FIXTURE_CLI_OK" }],
        invocation_id: `agent-invocation-sha256:${createHash("sha256").update("fixture-message").digest("hex")}`,
      }),
    });
    expect(message.status).toBe(200);
    expect(await message.json()).toMatchObject({
      accepted: true,
      inbox_id: "room:room-fixture",
    });
    const queued = await fetch(origin + "/__test__/task-turn", {
      method: "POST",
      headers: { authorization: "Bearer fixture-service" },
      body: JSON.stringify({
        agent_id: "agent-fixture",
        actor_id: "actor-agent-fixture",
        task_id: "task-fixture",
        room_id: "room-fixture",
        message_id: "input-fixture",
        text: "Intermediate Task checkpoint",
      }),
    });
    expect(queued.status).toBe(202);
    const claimed = (await post("/v0/task-execution-claims", {
      worker_id: "worker-fixture",
    })) as components["schemas"]["TaskWorkerExecution"];
    const execution = claimed.execution;
    if (!claimed.lease) throw new Error("Task claim did not return a lease");
    const effect = execution.pending_effects[0];
    if (!effect)
      throw new Error("Task claim did not return an accepted effect");
    expect(execution.generation).toBe(1);
    expect(effect.payload).toMatchObject({
      attempt_id: "stage-c-attempt-task-fixture-1",
      input_revision: 1,
    });
    const reread = await fetch(origin + "/v0/task-executions/task-fixture", {
      headers: {
        authorization: "Bearer fixture-service",
        "task-lease-token": claimed.lease.lease_token,
      },
    });
    const persisted =
      (await reread.json()) as components["schemas"]["TaskWorkerExecution"];
    expect(persisted.execution.pending_effects[0]?.payload).toEqual(
      effect.payload,
    );
  } finally {
    readyWatcher.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(directory, { recursive: true, force: true });
  }
});
