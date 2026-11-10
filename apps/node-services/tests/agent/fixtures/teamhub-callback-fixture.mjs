import { createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import http from "node:http";

import { createTeamHubRuntimeStateFixture } from "./teamhub-runtime-state-fixture.mjs";

const port = Number(requiredArgument("--port"));
const outputFile = requiredArgument("--output-file");
const readyFile = requiredArgument("--ready-file");
const serviceToken = requiredArgument("--service-token");
const tenantId = requiredArgument("--tenant-id");
const inboxStateFile = requiredArgument("--inbox-state-file");
const credentialExpiresAt = new Date(Date.now() + 48 * 3_600_000).toISOString();
let retiredInvocationRequests = 0;
const runtimeState = createTeamHubRuntimeStateFixture({
  serviceToken,
  inboxStateFile,
});

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("--port must be a valid TCP port");
}

const server = http.createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: safeMessage(error) }));
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
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (
    request.method === "POST" &&
    /^\/v0\/agents\/[^/]+\/invocations$/.test(url.pathname)
  ) {
    retiredInvocationRequests += 1;
  }
  if (
    request.method === "GET" &&
    url.pathname === "/__test__/retired-invocation-requests"
  ) {
    if (!authorizeService(request, response)) return;
    writeJson(response, 200, { count: retiredInvocationRequests });
    return;
  }
  if (await runtimeState.handle(request, response, url)) return;
  if (
    request.method === "GET" &&
    /^\/v0\/agents\/[^/]+\/effective-resources$/.test(url.pathname)
  ) {
    if (!authorizeService(request, response)) return;
    writeJson(response, 200, {
      effective_sha256: "0".repeat(64),
      connected_apps: true,
      skills: [],
    });
    return;
  }
  const credentialMatch =
    request.method === "POST"
      ? /^\/internal\/agents\/([^/]+)\/access-credentials$/.exec(url.pathname)
      : null;
  if (credentialMatch) {
    if (!authorizeService(request, response)) return;
    await readJson(request);
    const agentId = decodeURIComponent(credentialMatch[1]);
    writeJson(response, 201, {
      credential_id: `credential-${agentId}`,
      expires_at: credentialExpiresAt,
      tenant_id: tenantId,
      agent_id: agentId,
      access_token: `th_agent_${createHash("sha256").update(agentId).digest("base64url")}`,
    });
    return;
  }
  const identityMatch =
    request.method === "GET"
      ? /^\/v0\/agents\/([^/]+)\/identity$/.exec(url.pathname)
      : null;
  if (identityMatch) {
    if (!authorizeService(request, response)) return;
    const agentId = decodeURIComponent(identityMatch[1]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        agent_id: agentId,
        agent_type: "anotherme",
        actor: {
          id: `actor-${agentId}`,
          kind: "agent",
          tenant_id: tenantId,
          display_name: agentId,
        },
        sponsor: {
          id: "human-smoke",
          display_name: "Smoke Human",
        },
      }),
    );
    return;
  }

  const workItemsMatch =
    request.method === "GET"
      ? /^\/v0\/agents\/([^/]+)\/work-items$/.exec(url.pathname)
      : null;
  if (workItemsMatch) {
    if (!authorizeService(request, response)) return;
    writeJson(response, 200, {
      items: [],
      page: { has_more: false },
    });
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
    const body = await readJson(request);
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      !validContextReference(body.context)
    ) {
      writeJson(response, 400, { error: "invalid_context_resolve_request" });
      return;
    }
    writeJson(response, 200, { agent_id: agentId, context: body.context });
    return;
  }

  const callbackMatch =
    request.method === "POST"
      ? /^\/v0\/rooms\/([^/]+)\/agents\/([^/]+)\/messages$/.exec(url.pathname)
      : null;
  if (callbackMatch) {
    if (!authorizeService(request, response)) return;
    const encodedBody = await readBody(request);
    const contentType = request.headers["content-type"] ?? null;
    const idempotencyKey = request.headers["idempotency-key"] ?? null;
    await appendFile(
      outputFile,
      `${JSON.stringify({
        path: url.pathname,
        headers: {
          authorization_present: true,
          content_type: contentType,
          idempotency_key: idempotencyKey,
        },
        body: JSON.parse(encodedBody),
      })}\n`,
    );
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
}

function authorizeService(request, response) {
  if (request.headers.authorization === `Bearer ${serviceToken}`) return true;
  writeJson(response, 401, { error: "unauthorized" });
  return false;
}

function validContextReference(value) {
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value).sort();
  if (value.kind === "meta") {
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
    keys.length === 2 &&
    keys[0] === "kind" &&
    keys[1] === "task_id"
  );
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  return JSON.parse(await readBody(request));
}

async function readBody(request) {
  return (await readBodyBuffer(request)).toString("utf8");
}

async function readBodyBuffer(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error("Request body exceeds one MiB");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeMessage(error) {
  return error instanceof Error ? error.message : "Callback fixture failed";
}
