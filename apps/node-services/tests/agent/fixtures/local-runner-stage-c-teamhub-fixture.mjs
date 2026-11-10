import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { ZipFile } from "yazl";

import { createTeamHubRuntimeStateFixture } from "./teamhub-runtime-state-fixture.mjs";

const port = Number(requiredArgument("--port"));
const readyFile = requiredArgument("--ready-file");
const reportFile = requiredArgument("--report-file");
const artifactDirectory = requiredArgument("--artifact-directory");
const serviceToken = requiredArgument("--service-token");
const tenantId = requiredArgument("--tenant-id");
const inboxStateFile = requiredArgument("--inbox-state-file");
const skillManifestId = "skill_manifest_stage_c";
const artifacts = new Map();
// This process remains authoritative while the real Agent Service and daemon
// restart. Keep independent credential expiry/revocation state; reads never extend it.
const agentCredentials = new Map();
let credentialClockOffsetMs = 0;
const cliReceipts = new Map();
let taskExecution = null;
const taskAcceptedInputs = new Map();
let taskLease = null;
let taskExecutionCompleted = false;
let publishedMessageSequence = 0;
const runtimeState = createTeamHubRuntimeStateFixture({
  serviceToken,
  inboxStateFile,
});

const skillFiles = new Map([
  [
    "SKILL.md",
    Buffer.from(
      [
        "---",
        "name: stage-c-verifier",
        "description: Verify the current Local Runner Execution Context resources.",
        "---",
        "",
        "Read `references/protocol.txt` and follow the requested verification steps.",
        "",
      ].join("\n"),
    ),
  ],
  [
    "references/protocol.txt",
    Buffer.from(
      [
        "SKILL_MARKER=stage-c-skill-loaded",
        "When asked to create an output, include this exact line:",
        "SKILL_EXECUTION_MARKER=stage-c-skill-instruction-followed",
        "",
      ].join("\n"),
    ),
  ],
]);
const skillPackageSha256 = canonicalSkillPackageDigest(skillFiles);
const skillArchive = await createSkillArchive("stage-c-verifier", skillFiles);
const skillItem = {
  skill_id: "skill-stage-c",
  manifest_id: skillManifestId,
  manifest_version: "1.0.0",
  name: "stage-c-verifier",
  package_sha256: skillPackageSha256,
  source: "explicit",
  config: {},
};

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("--port must be a valid TCP port");
}
await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });

const server = http.createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    writeJson(response, 500, { error: safeMessage(error) });
  }
});

server.listen(port, "127.0.0.1", async () => {
  await writeFile(readyFile, String(process.pid));
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  runtimeState.close();
  server.close(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (
    request.method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/healthz")
  ) {
    writeJson(response, 200, { status: "ok" });
    return;
  }
  if (await handleAgentCli(request, response, url)) return;
  if (await runtimeState.handle(request, response, url)) return;
  if (
    request.method === "GET" &&
    /^\/v0\/agents\/[^/]+\/effective-resources$/.test(url.pathname)
  ) {
    if (!authorizeService(request, response)) return;
    writeJson(response, 200, {
      effective_sha256: skillPackageSha256,
      connected_apps: true,
      skills: [skillItem],
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__test__/task-turn") {
    if (!authorizeService(request, response)) return;
    if (taskExecution && !taskExecutionCompleted) {
      writeJson(response, 409, { error: "task_execution_active" });
      return;
    }
    const body = JSON.parse(await readBody(request));
    taskExecution = createTaskExecution(body);
    taskLease = null;
    taskExecutionCompleted = false;
    writeJson(response, 202, { accepted: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__test__/task-cancel") {
    if (!authorizeService(request, response)) return;
    requestTaskCancellation(JSON.parse(await readBody(request)));
    writeJson(response, 202, { accepted: true });
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/v0/task-execution-claims"
  ) {
    if (!authorizeService(request, response)) return;
    if (!taskExecution || taskExecutionCompleted || taskLease) {
      response.writeHead(204);
      response.end();
      return;
    }
    const body = JSON.parse(await readBody(request));
    taskLease = createTaskLease(taskExecution.task_id, body.worker_id);
    writeJson(response, 200, taskExecutionBundle());
    return;
  }
  const taskExecutionMatch = /^\/v0\/task-executions\/([^/]+)$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && taskExecutionMatch) {
    if (!authorizeTaskLease(request, response, taskExecutionMatch[1])) return;
    writeJson(response, 200, taskExecutionBundle());
    return;
  }
  const taskHeartbeatMatch =
    request.method === "POST"
      ? /^\/v0\/task-executions\/([^/]+)\/heartbeat$/.exec(url.pathname)
      : null;
  if (taskHeartbeatMatch) {
    if (!authorizeTaskLease(request, response, taskHeartbeatMatch[1])) return;
    taskLease = { ...taskLease, lease_expires_at: futureIso(60) };
    writeJson(response, 200, taskLease);
    return;
  }
  const taskTransitionMatch =
    request.method === "POST"
      ? /^\/v0\/task-executions\/([^/]+)\/transitions$/.exec(url.pathname)
      : null;
  if (taskTransitionMatch) {
    if (!authorizeTaskLease(request, response, taskTransitionMatch[1])) return;
    const body = JSON.parse(await readBody(request));
    applyTaskTransition(body);
    const releaseLease = body.transition === "reconcile_attempt";
    const bundle = taskExecutionBundle(releaseLease);
    if (releaseLease) taskLease = null;
    writeJson(response, 200, bundle);
    return;
  }

  const resolveContextMatch =
    request.method === "POST"
      ? /^\/internal\/agents\/([^/]+)\/mcp-context\/actions\/resolve$/.exec(
          url.pathname,
        )
      : null;
  if (resolveContextMatch) {
    if (!authorizeService(request, response)) return;
    const agentId = decodeURIComponent(resolveContextMatch[1]);
    const body = JSON.parse(await readBody(request));
    if (
      Object.keys(body).length !== 1 ||
      !validContextReference(body.context)
    ) {
      writeJson(response, 400, { error: "invalid_context_resolve_request" });
      return;
    }
    writeJson(response, 200, { agent_id: agentId, context: body.context });
    return;
  }
  const identityMatch =
    request.method === "GET"
      ? /^\/v0\/agents\/([^/]+)\/identity$/.exec(url.pathname)
      : null;
  if (identityMatch) {
    if (!authorizeService(request, response)) return;
    const agentId = decodeURIComponent(identityMatch[1]);
    writeJson(response, 200, {
      agent_id: agentId,
      agent_type: "general",
      actor: {
        id: `actor-${agentId}`,
        kind: "agent",
        tenant_id: tenantId,
        display_name: agentId,
      },
      sponsor: { id: "human-live", display_name: "Live Smoke Human" },
    });
    return;
  }
  const workItemsMatch =
    request.method === "GET"
      ? /^\/v0\/agents\/([^/]+)\/work-items$/.exec(url.pathname)
      : null;
  if (workItemsMatch) {
    if (!authorizeService(request, response)) return;
    writeJson(response, 200, { items: [], page: { has_more: false } });
    return;
  }
  writeJson(response, 404, { error: "not_found" });
}

const credentialNow = () => Date.now() + credentialClockOffsetMs;
const credentialResponse = (record, token) => ({
  credential_id: record.credential_id,
  tenant_id: tenantId,
  agent_id: record.agent_id,
  access_token: token,
  expires_at: record.expires_at,
});

async function handleAgentCli(request, response, url) {
  if (
    request.method === "POST" &&
    url.pathname === "/__test__/agent-credentials/clock"
  ) {
    if (!authorizeService(request, response)) return true;
    const body = JSON.parse(await readBody(request));
    if (!Number.isSafeInteger(body.advance_ms) || body.advance_ms < 0) {
      writeJson(response, 400, { error: "invalid_clock_advance" });
      return true;
    }
    credentialClockOffsetMs += body.advance_ms;
    writeJson(response, 200, { advanced: true });
    return true;
  }
  const credentialMatch =
    /^\/internal\/agents\/([^/]+)\/access-credentials$/.exec(url.pathname);
  if (request.method === "POST" && credentialMatch) {
    if (!authorizeService(request, response)) return true;
    const body = JSON.parse(await readBody(request));
    const agentId = decodeURIComponent(credentialMatch[1]);
    if (
      typeof body.label !== "string" ||
      !body.label.trim() ||
      Object.keys(body).some((key) => key !== "label")
    ) {
      writeJson(response, 400, { error: "invalid_credential_request" });
      return true;
    }
    // This fixture supports ordinary active Agents.
    if (!runtimeState.allowsManagedCredential(agentId, tenantId)) {
      writeJson(response, 403, { error: "agent_forbidden" });
      return true;
    }
    const token = `th_agent_${randomBytes(32).toString("base64url")}`;
    const record = {
      credential_id: `credential-${randomUUID()}`,
      agent_id: agentId,
      token_hash: sha256(token),
      expires_at: new Date(credentialNow() + 48 * 3_600_000).toISOString(),
    };
    agentCredentials.set(record.credential_id, record);
    await report({
      type: "agent.credential.issued",
      credential_id: record.credential_id,
      agent_id: agentId,
      expires_at: record.expires_at,
    });
    writeJson(response, 201, credentialResponse(record, token));
    return true;
  }
  if (!url.pathname.startsWith("/api/agent/v1/")) return false;
  const tokenHash = sha256(
    request.headers.authorization?.replace(/^Bearer /, "") ?? "",
  );
  const credential = [...agentCredentials.values()].find(
    (record) =>
      runtimeState.allowsManagedCredential(record.agent_id, tenantId) &&
      record.token_hash === tokenHash &&
      Date.parse(record.expires_at) > credentialNow(),
  );
  if (!credential) {
    writeJson(response, 401, { error: "agent_credential_required" });
    return true;
  }
  const agentId = credential.agent_id;
  const skillMatch =
    request.method === "GET"
      ? /^\/api\/agent\/v1\/skills\/packages\/([^/]+)$/.exec(url.pathname)
      : null;
  if (skillMatch) {
    const manifestId = decodeURIComponent(skillMatch[1]);
    if (manifestId !== skillManifestId) {
      writeJson(response, 404, { error: "skill_not_found" });
      return true;
    }
    await report({
      type: "skill.package.downloaded",
      agent_id: agentId,
      manifest_id: manifestId,
      package_sha256: skillPackageSha256,
    });
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": String(skillArchive.byteLength),
      "content-type": "application/zip",
      etag: `"${skillPackageSha256}"`,
    });
    response.end(skillArchive);
    return true;
  }
  const kind = request.headers["x-teamhub-context-kind"];
  const targetId = request.headers["x-teamhub-context-id"];
  const businessInbox = await runtimeState.readBusinessInbox(
    agentId,
    tenantId,
    `${kind}:${targetId}`,
  );
  if (!businessInbox) {
    writeJson(response, 403, { error: "target_forbidden" });
    return true;
  }
  const fileMatch = /^\/api\/agent\/v1\/files\/([^/]+)\/content$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && fileMatch) {
    const document = businessInbox.documents.find(
      (item) => item.id === decodeURIComponent(fileMatch[1]),
    );
    if (!document) {
      writeJson(response, 404, { error: "document_not_found" });
      return true;
    }
    const content = Buffer.from(document.content);
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
      "x-document-id": document.id,
      "x-document-version-id": `version-${sha256(content)}`,
      "x-document-filename": Buffer.from(document.filename).toString(
        "base64url",
      ),
      "x-document-read-only": "true",
      "x-content-sha256": sha256(content),
    });
    response.end(content);
    await report({
      type: "document.downloaded",
      agent_id: agentId,
      document_id: document.id,
      sha256: sha256(content),
    });
    return true;
  }
  const operationId = request.headers["x-teamhub-operation-id"];
  if (
    typeof operationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)
  ) {
    writeJson(response, 400, { error: "operation_id_required" });
    return true;
  }
  const bytes = await readBodyBuffer(request, 52 * 1024 * 1024);
  const key = `${agentId}:${kind}:${targetId}:${operationId}`;
  const digest = sha256(
    Buffer.concat([Buffer.from(url.pathname + url.search), bytes]),
  );
  const receipt = cliReceipts.get(key);
  if (receipt) {
    writeJson(
      response,
      receipt.digest === digest ? 200 : 409,
      receipt.digest === digest
        ? receipt.result
        : { error: "operation_conflict" },
    );
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/agent/v1/messages") {
    const input = JSON.parse(bytes.toString("utf8"));
    if (
      kind !== "room" ||
      input.inbox_id !== `room:${targetId}` ||
      !Array.isArray(input.message_segments) ||
      input.message_segments.length < 1 ||
      Object.keys(input).some(
        (key) =>
          !["inbox_id", "message_segments", "invocation_id"].includes(key),
      ) ||
      (input.invocation_id !== undefined &&
        input.invocation_id !==
          `agent-invocation-sha256:${sha256(operationId)}`) ||
      input.message_segments.some(
        (segment) =>
          segment.type !== "text" ||
          typeof segment.content !== "string" ||
          !segment.content,
      )
    ) {
      writeJson(response, 400, { error: "invalid_message" });
      return true;
    }
    const messageId = `message-live-${++publishedMessageSequence}`;
    const result = {
      accepted: true,
      inbox_id: `room:${targetId}`,
      message_id: messageId,
    };
    await report({
      type: "agent.messages.published",
      transport: "teamhub-cli",
      agent_id: agentId,
      room_id: targetId,
      command_operation_id: operationId,
      message_id: messageId,
      body_sha256: sha256(
        input.message_segments.map((segment) => segment.content).join(""),
      ),
      idempotency_key_present: true,
    });
    cliReceipts.set(key, { digest, result });
    writeJson(response, 200, result);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/agent/v1/files") {
    const documentId = url.searchParams.get("document_id");
    const artifactId = documentId || "document_live_output";
    const current = artifacts.get(artifactId);
    if (
      (documentId &&
        (!current ||
          url.searchParams.get("base_version_id") !==
            current.publication.artifact_version_id)) ||
      (!documentId && current)
    ) {
      writeJson(response, 409, { error: "version_conflict" });
      return true;
    }
    const filename = url.searchParams.get("filename");
    if (!filename || /[/\\]/.test(filename)) {
      writeJson(response, 400, { error: "invalid_filename" });
      return true;
    }
    const artifact = await persistArtifact({
      artifactId,
      versionNumber: (current?.publication.version_number ?? 0) + 1,
      relativePath: `reports/${filename}`,
      mediaType: url.searchParams.get("media_type") || "text/plain",
      content: bytes,
    });
    artifacts.set(artifactId, artifact);
    const publication = artifact.publication;
    const result = {
      document_id: artifactId,
      version_id: publication.artifact_version_id,
      sha256: publication.sha256,
      unchanged: false,
    };
    await report({
      type: "artifact.published",
      transport: "teamhub-cli",
      agent_id: agentId,
      context_kind: kind,
      context_id: targetId,
      command_operation_id: operationId,
      operation: current ? "replace" : "create",
      artifact_id: artifactId,
      artifact_version_id: publication.artifact_version_id,
      version_number: publication.version_number,
      relative_path: publication.relative_path,
      size_bytes: publication.size_bytes,
      sha256: publication.sha256,
      idempotency_key_present: true,
    });
    cliReceipts.set(key, { digest, result });
    writeJson(response, 200, result);
    return true;
  }
  if (
    request.method === "POST" &&
    /^\/api\/agent\/v1\/files\/[^/]+\/share$/.test(url.pathname)
  ) {
    writeJson(response, 200, { shared: true });
    return true;
  }
  writeJson(response, 404, { error: "unsupported_cli_endpoint" });
  return true;
}

function createTaskExecution(input) {
  for (const field of [
    "agent_id",
    "actor_id",
    "task_id",
    "room_id",
    "message_id",
    "text",
  ]) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new Error(`${field} is required`);
    }
  }
  let acceptedInputs = taskAcceptedInputs.get(input.task_id);
  if (!acceptedInputs) {
    acceptedInputs = new Map();
    taskAcceptedInputs.set(input.task_id, acceptedInputs);
  }
  // These five-round checkpoints belong to one unfinished Task/attempt.
  // Accepted input revisions advance independently from Provider Local Runs.
  if (!acceptedInputs.has(input.message_id))
    acceptedInputs.set(input.message_id, acceptedInputs.size + 1);
  const acceptedInput = {
    attempt_id: `stage-c-attempt-${input.task_id}-1`,
    input_revision: acceptedInputs.get(input.message_id),
  };
  const publicMessage = {
    message_id: input.message_id,
    raw_message: input.text,
    segments: [{ type: "text", content: input.text }],
    author: {
      actor_id: "agent-live-harness",
      kind: "agent",
      display_name: "Stage C harness",
    },
  };
  const wake = {
    actor_id: input.actor_id,
    author_actor_id: "agent-live-harness",
    meta_seq: 1,
    public_message_ids: [input.message_id],
    message: {
      message_id: `wake-${input.message_id}`,
      raw_message: "A new Task input is available in the shared Task Inbox.",
      segments: [
        {
          type: "text",
          content: "A new Task input is available in the shared Task Inbox.",
        },
      ],
    },
  };
  const inputManifest = {
    room_id: input.room_id,
    source: "human_task_room_message",
    public_message_ids: [input.message_id],
    public_context_message: publicMessage,
    recipient_wakes: [wake],
    wake_author_actor_id: "agent-live-harness",
  };
  const effectId = `effect-${input.message_id}`;
  return {
    task_id: input.task_id,
    generation: 1,
    status: "running",
    execution_revision: 1,
    desired_control: "run",
    control_revision: 1,
    control_settled_revision: 1,
    run_spec: {
      schema_version: 1,
      result_agent_actor_id: input.actor_id,
      attempt_policy: {
        policy_version: 1,
        timeout_seconds: 1_800,
        max_retries: 0,
        retry_on_agent_failure: false,
        retry_on_timeout: false,
      },
    },
    participants: [
      {
        actor_id: input.actor_id,
        agent_id: input.agent_id,
        execution_context_ref: {
          kind: "alter_ego",
          agentId: input.agent_id,
          taskId: input.task_id,
        },
      },
    ],
    pending_effects: [
      {
        id: effectId,
        root_operation_id: `root-${effectId}`,
        operation: "submit_agent_turn",
        status: "pending",
        dispatch_sequence: 1,
        payload: {
          ...acceptedInput,
          recipient_actor_ids: [input.actor_id],
          input_manifest: inputManifest,
          message: publicMessage,
          public_context_message: publicMessage,
          recipient_wakes: [wake],
        },
        payload_hash: sha256(
          JSON.stringify({ effectId, inputManifest, acceptedInput }),
        ),
        created_at: new Date().toISOString(),
      },
    ],
    execution_facts: [],
    execution_updated_at: new Date().toISOString(),
  };
}

function requestTaskCancellation(input) {
  if (!taskExecution || taskExecutionCompleted) {
    throw new Error("No active Task execution to cancel");
  }
  const submit = taskExecution.pending_effects.find(
    (effect) =>
      effect.operation === "submit_agent_turn" && effect.status === "succeeded",
  );
  const participantRun = submit?.observation?.participant_runs?.find(
    (run) =>
      run.agent_run_ref === input.run_id &&
      run.agent_management_id === input.agent_id &&
      run.actor_id === input.actor_id,
  );
  if (!submit || !participantRun || taskExecution.task_id !== input.task_id) {
    throw new Error("Task cancellation does not match the active Agent Run");
  }
  const cleanupId = `effect-cleanup-${submit.id}`;
  taskExecution.status = "terminated";
  taskExecution.desired_control = "terminate";
  taskExecution.pending_effects.push({
    id: cleanupId,
    root_operation_id: `root-${cleanupId}`,
    operation: "cleanup_runtime",
    status: "pending",
    dispatch_sequence: submit.dispatch_sequence + 1,
    payload: {
      actor_id: input.actor_id,
      agent_management_id: input.agent_id,
      agent_run_ref: input.run_id,
      execution_context_ref: {
        kind: "alter_ego",
        agentId: input.agent_id,
        taskId: input.task_id,
      },
    },
    payload_hash: sha256(JSON.stringify({ cleanupId, runId: input.run_id })),
    created_at: new Date().toISOString(),
  });
  taskExecution.execution_revision += 1;
  taskExecution.execution_updated_at = new Date().toISOString();
  taskLease = null;
}

function createTaskLease(taskId, workerId) {
  if (typeof workerId !== "string" || workerId.length === 0) {
    throw new Error("worker_id is required");
  }
  return {
    task_id: taskId,
    worker_id: workerId,
    lease_token: "stage-c-task-lease-token-00000000000000000000",
    lease_generation: 1,
    lease_expires_at: futureIso(60),
  };
}

function taskExecutionBundle(releaseLease = false) {
  return {
    ...(releaseLease || !taskLease ? {} : { lease: taskLease }),
    execution: taskExecution,
  };
}

function authorizeTaskLease(request, response, encodedTaskId) {
  if (!authorizeService(request, response)) return false;
  const taskId = decodeURIComponent(encodedTaskId);
  if (
    !taskExecution ||
    !taskLease ||
    taskExecution.task_id !== taskId ||
    request.headers["task-lease-token"] !== taskLease.lease_token
  ) {
    writeJson(response, 409, { error: "task_lease_mismatch" });
    return false;
  }
  return true;
}

function applyTaskTransition(body) {
  if (!taskExecution) throw new Error("No active Task execution");
  const effect = taskExecution.pending_effects.find(
    ({ id }) => id === body.payload?.effect_id,
  );
  if (!effect && body.transition !== "reconcile_attempt") {
    throw new Error("Task transition effect is missing");
  }
  if (body.expected_execution_revision !== taskExecution.execution_revision) {
    throw new Error("Task execution revision mismatch");
  }
  switch (body.transition) {
    case "begin_effect_dispatch":
      if (!effect || effect.status !== "pending") {
        throw new Error("Invalid begin_effect_dispatch transition");
      }
      effect.status = "dispatching";
      break;
    case "record_agent_turn":
      if (!effect || effect.status !== "dispatching") {
        throw new Error("Invalid record_agent_turn transition");
      }
      effect.status = "succeeded";
      effect.observation = {
        participant_runs: body.payload.participant_runs,
        participant_terminals: [],
      };
      break;
    case "record_agent_terminal":
      if (!effect || effect.status !== "succeeded") {
        throw new Error("Invalid record_agent_terminal transition");
      }
      effect.observation.participant_terminals =
        body.payload.participant_terminals;
      taskExecution.status = terminalTaskStatus(
        body.payload.participant_terminals[0]?.status,
      );
      taskExecutionCompleted = true;
      break;
    case "complete_runtime_cleanup":
      if (
        !effect ||
        effect.operation !== "cleanup_runtime" ||
        effect.status !== "dispatching"
      ) {
        throw new Error("Invalid complete_runtime_cleanup transition");
      }
      effect.status = "succeeded";
      effect.observation = {
        agent_run_ref: body.payload.agent_run_ref,
        cancel_status: body.payload.cancel_status,
        run_status: body.payload.run_status,
      };
      taskExecutionCompleted = true;
      break;
    case "reconcile_attempt":
      break;
    default:
      throw new Error(`Unexpected Task transition ${body.transition}`);
  }
  taskExecution.execution_revision += 1;
  taskExecution.execution_updated_at = new Date().toISOString();
}

function terminalTaskStatus(status) {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "canceled") return "terminated";
  throw new Error("Task terminal status is required");
}

function futureIso(seconds) {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

async function persistArtifact(input) {
  const filename = path.posix.basename(input.relativePath);
  const artifactVersionId = `${input.artifactId}-v${input.versionNumber}`;
  const sha = sha256(input.content);
  const destination = path.join(
    artifactDirectory,
    `${input.artifactId}-v${input.versionNumber}-${filename}`,
  );
  await writeFile(destination, input.content, { mode: 0o600 });
  return {
    outputPath: destination,
    publication: {
      artifact_id: input.artifactId,
      artifact_version_id: artifactVersionId,
      room_id: input.roomId,
      relative_path: input.relativePath,
      version_number: input.versionNumber,
      filename,
      media_type: input.mediaType,
      size_bytes: input.content.byteLength,
      sha256: sha,
      created_at: new Date().toISOString(),
    },
  };
}

async function createSkillArchive(packageName, files) {
  const zip = new ZipFile();
  const chunks = [];
  zip.outputStream.on("data", (chunk) => chunks.push(chunk));
  for (const [filePath, content] of [...files].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    zip.addBuffer(content, `${packageName}/${filePath}`, { mode: 0o644 });
  }
  zip.end();
  await once(zip.outputStream, "end");
  return Buffer.concat(chunks);
}

function canonicalSkillPackageDigest(files) {
  const hash = createHash("sha256");
  hash.update("teamhub.skill-package.v1\0");
  const field = Buffer.allocUnsafe(8);
  for (const [filePath, content] of [...files].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  )) {
    const encodedPath = Buffer.from(filePath, "utf8");
    field.writeBigUInt64BE(BigInt(encodedPath.byteLength));
    hash.update(field);
    hash.update(encodedPath);
    field.writeBigUInt64BE(BigInt(content.byteLength));
    hash.update(field);
    hash.update(Buffer.from(sha256(content), "hex"));
  }
  return hash.digest("hex");
}

function authorizeService(request, response) {
  if (request.headers.authorization === `Bearer ${serviceToken}`) return true;
  writeJson(response, 401, { error: "unauthorized" });
  return false;
}

function validContextReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.kind === "meta") {
    const keys = Object.keys(value);
    const allowed = new Set(["kind", "room_id"]);
    return (
      keys.every((key) => allowed.has(key)) &&
      typeof value.room_id === "string" &&
      value.room_id.length > 0
    );
  }
  return (
    value.kind === "alter_ego" &&
    typeof value.task_id === "string" &&
    value.task_id.length > 0 &&
    Object.keys(value).length === 2
  );
}

async function report(event) {
  await appendFile(reportFile, `${JSON.stringify(event)}\n`);
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  return (await readBodyBuffer(request)).toString("utf8");
}

async function readBodyBuffer(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body exceeds limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeMessage(error) {
  return error instanceof Error ? error.message : "Stage C fixture failed";
}
