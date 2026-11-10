import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

interface OpenApiSchema {
  $ref?: string;
  additionalProperties?: boolean;
  discriminator?: { propertyName?: string };
  enum?: unknown[];
  oneOf?: OpenApiSchema[];
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
}

interface OpenApiDocument {
  security?: Array<Record<string, unknown[]>>;
  components?: {
    parameters?: Record<string, unknown>;
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, unknown>;
  };
  paths?: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        requestBody?: {
          content?: Record<string, { schema?: OpenApiSchema }>;
        };
        responses?: Record<string, unknown>;
        security?: Array<Record<string, unknown[]>>;
      }
    >
  >;
}

const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "linger-agent-run-contract-"),
);

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

const bundleContract = (name: string, source: string): OpenApiDocument => {
  const output = join(temporaryDirectory, `${name}.json`);
  execFileSync(
    "pnpm",
    ["exec", "redocly", "bundle", source, "--output", output],
    { stdio: "ignore" },
  );
  return JSON.parse(readFileSync(output, "utf8")) as OpenApiDocument;
};

const nodeServicesInternal = bundleContract(
  "node-services-internal",
  "contracts/openapi/node-services-internal/openapi.yaml",
);
const teamhubInternal = bundleContract(
  "teamhub-internal",
  "contracts/openapi/teamhub-internal/openapi.yaml",
);
const teamhubAgentApi = bundleContract(
  "teamhub-agent-api",
  "contracts/openapi/teamhub-agent-api/openapi.yaml",
);

// Keep only the given paths and the components they reach, so one caller's
// operations can be checked on their own.
const restrictToPaths = (
  document: OpenApiDocument,
  include: (path: string) => boolean,
): OpenApiDocument => {
  const paths = Object.fromEntries(
    Object.entries(document.paths ?? {}).filter(([path]) => include(path)),
  );
  const components: Record<string, Record<string, unknown>> = {};
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        key !== "$ref" ||
        typeof child !== "string" ||
        !child.startsWith("#/components/")
      ) {
        visit(child);
        continue;
      }
      const [, , kind, name] = child.split("/");
      const source = (
        document.components as Record<string, Record<string, unknown>>
      )[kind!];
      if (Object.hasOwn(components[kind!] ?? {}, name!)) continue;
      (components[kind!] ??= {})[name!] = source?.[name!];
      visit(source?.[name!]);
    }
  };
  visit(paths);
  return {
    security: document.security,
    components: {
      ...components,
      securitySchemes: document.components?.securitySchemes,
    },
    paths,
  };
};

// Agent management owns every /v1/ route in node-services-internal; Memory,
// LLM Wiki and the Document Runtime use /internal/, /v0/ and health routes.
const agentManagement = restrictToPaths(nodeServicesInternal, (path) =>
  path.startsWith("/v1/"),
);
// Document Runtime, MCP Context and Voice Runtime routes in teamhub-internal
// are not Agent Service callbacks.
const agentCallback = restrictToPaths(
  teamhubInternal,
  (path) =>
    !path.startsWith("/internal/v1/document-") &&
    !path.startsWith("/internal/v1/voice/") &&
    !path.includes("/mcp-context/"),
);
const teamhubPublic = bundleContract(
  "teamhub-public",
  "contracts/openapi/teamhub-public/teamhub-api.openapi.yaml",
);
const runtimeStateSource = parse(
  readFileSync("contracts/openapi/components/agent-runtime-state.yaml", "utf8"),
) as {
  components?: { schemas?: Record<string, unknown> };
};
const personalWikiSource = parse(
  readFileSync(
    "contracts/openapi/components/personal-wiki-worker.yaml",
    "utf8",
  ),
) as {
  components?: { schemas?: Record<string, unknown> };
};
const callbackAuthoritySchemaNames = new Set([
  ...Object.keys(runtimeStateSource.components?.schemas ?? {}),
  ...Object.keys(personalWikiSource.components?.schemas ?? {}),
]);
const cliFileAuthority = parse(
  readFileSync("contracts/openapi/components/agent-cli-files.yaml", "utf8"),
) as OpenApiDocument;
for (const source of [
  cliFileAuthority,
  ...["agent-access-credentials"].map(
    (name) =>
      parse(
        readFileSync(`contracts/openapi/components/${name}.yaml`, "utf8"),
      ) as OpenApiDocument,
  ),
]) {
  for (const name of Object.keys(source.components?.schemas ?? {}))
    callbackAuthoritySchemaNames.add(name);
}
const agentRunBoundaryCallback: OpenApiDocument = {
  ...agentCallback,
  components: {
    ...agentCallback.components,
    parameters: Object.fromEntries(
      Object.entries(agentCallback.components?.parameters ?? {}).filter(
        ([name]) =>
          !Object.hasOwn(cliFileAuthority.components?.parameters ?? {}, name),
      ),
    ),
    schemas: Object.fromEntries(
      Object.entries(agentCallback.components?.schemas ?? {}).filter(
        ([name]) => !callbackAuthoritySchemaNames.has(name),
      ),
    ),
  },
  paths: Object.fromEntries(
    Object.entries(agentCallback.paths ?? {}).filter(
      ([path]) =>
        !path.startsWith("/v0/agent-runtime/") &&
        !path.startsWith("/v0/agents/{agentId}/files") &&
        !path.includes("/access-credentials") &&
        !path.startsWith("/api/agent/v1/") &&
        !path.startsWith("/v0/personal-wikis/"),
    ),
  ),
};
// Native Computer capabilities carry a TeamHub-authorized scope; they do not
// create an Agent Run. Keep the Run boundary assertion on the remaining API.
const agentRunManagement = restrictToPaths(
  agentManagement,
  (path) => path !== "/v1/local-computer-tools:call",
);
const agentRunBoundaryManagement: OpenApiDocument = {
  ...agentRunManagement,
  components: {
    ...agentRunManagement.components,
    schemas: Object.fromEntries(
      Object.entries(agentRunManagement.components?.schemas ?? {}).filter(
        ([name]) => !name.startsWith("AgentDebug"),
      ),
    ),
  },
  paths: Object.fromEntries(
    Object.entries(agentRunManagement.paths ?? {}).filter(
      ([path]) => !path.startsWith("/v1/agent-debug/"),
    ),
  ),
};

const schemas = (document: OpenApiDocument) =>
  document.components?.schemas ?? {};

const expectStrictObject = (
  document: OpenApiDocument,
  schemaNames: string[],
) => {
  for (const schemaName of schemaNames) {
    expect(schemas(document)[schemaName], schemaName).toMatchObject({
      additionalProperties: false,
    });
  }
};

describe("Agent Run wire contracts", () => {
  it("opens a process epoch instead of service sessions and Context leases", () => {
    const epoch = agentCallback.paths?.["/v0/agent-runtime/epochs"]?.post;
    expect(epoch?.operationId).toBe("startAgentServiceEpoch");
    expect(epoch?.security ?? agentCallback.security).toEqual([
      { serviceBearer: [] },
    ]);
    expect(epoch?.responses).toHaveProperty("200");
    expect(epoch?.requestBody?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/StartAgentServiceEpochRequest",
    });
    const callbackSchemas = schemas(agentCallback);
    expectStrictObject(agentCallback, [
      "StartAgentServiceEpochRequest",
      "AgentServiceEpochStart",
    ]);
    expect(callbackSchemas.StartAgentServiceEpochRequest?.required).toEqual([
      "epoch",
    ]);
    expect(callbackSchemas.AgentServiceEpochStart?.required).toEqual([
      "interrupted_run_ids",
      "waiting_context_keys",
    ]);
    for (const route of [
      "/v0/agent-runtime/sessions/start",
      "/v0/agent-runtime/sessions/stop",
      "/v0/agent-runtime/contexts/claim",
      "/v0/agent-runtime/contexts/renew",
      "/v0/agent-runtime/contexts/release",
      "/v0/agent-runtime/contexts/recovery-snapshot",
      "/v0/agent-runtime/file-projection/repair",
      "/v0/agent-runtime/file-projection/changes",
      "/v0/agent-runtime/inbox-projection-wakes",
    ])
      expect(agentCallback.paths).not.toHaveProperty(route);
  });
  it("keeps runtime callbacks service-authenticated and CLI file requests on independent Agent credentials", () => {
    let defaultSecured = 0;
    for (const [route, methods] of Object.entries(agentCallback.paths ?? {}))
      for (const operation of Object.values(methods)) {
        if (operation.security) continue;
        defaultSecured += 1;
        expect(agentCallback.security, route).toEqual([{ serviceBearer: [] }]);
      }
    expect(defaultSecured).toBeGreaterThan(0);
    for (const [route, methods] of Object.entries(agentCallback.paths ?? {})) {
      if (!route.startsWith("/v0/agents/{agentId}/files")) continue;
      for (const method of ["get", "post"])
        if (methods[method])
          expect(methods[method].security ?? agentCallback.security).toEqual([
            { serviceBearer: [] },
          ]);
    }
    expect(
      Object.keys(nodeServicesInternal.paths ?? {}).some(
        (route) =>
          route.startsWith("/v1/cli/") ||
          route.startsWith("/v1/local-teamhub-cli/"),
      ),
    ).toBe(false);
    expect(
      Object.keys(teamhubInternal.paths ?? {}).some((route) =>
        route.startsWith("/api/agent/v1/"),
      ),
    ).toBe(false);
    let cliFileOperations = 0;
    for (const [route, methods] of Object.entries(
      teamhubAgentApi.paths ?? {},
    )) {
      if (!route.startsWith("/api/agent/v1/files")) continue;
      for (const method of ["get", "post"])
        if (methods[method]) {
          cliFileOperations += 1;
          expect(methods[method].security, route).toEqual([
            { agentBearer: [] },
          ]);
        }
    }
    expect(cliFileOperations).toBe(7);
  });
  it("keeps only TeamHub cancellation inside Agent management", () => {
    expect(nodeServicesInternal.paths).not.toHaveProperty(
      "/v1/agent-runs/{runId}/start",
    );
    expect(
      agentManagement.paths?.["/v1/agent-runs/{runId}/cancel"]?.post
        ?.operationId,
    ).toBe("cancelAgentRun");
    expect(schemas(agentManagement).CancelAgentRunRequest?.required).toEqual([
      "request_id",
      "run_id",
    ]);
  });

  it("retires the TeamHub Run protocol, Agent Inbox and legacy recovery callbacks", () => {
    for (const path of [
      "/v0/agent-runs/{runId}/open",
      "/v0/agent-runs/{runId}/events",
      "/v0/agent-runs/{runId}/artifacts/{artifactVersionId}/content",
      "/v0/agent-runs/{runId}/artifacts/{artifactVersionId}/reads",
      "/v0/agent-runs/{runId}/outputs",
      "/v0/agent-runs/{runId}/transfer-capabilities",
      "/v0/agent-runs/{runId}/steers",
      "/v0/agent-runs/{runId}/reconcile",
      "/v0/agent-runs/{runId}/skills/{skillId}/versions/{manifestVersion}/content",
      "/v0/agent-run-transfers/{transferToken}",
      "/v0/agent-invocations",
      "/v0/agents/{agentId}/invocations",
      "/v0/agents/{agentId}/inbox",
      "/v0/agents/{agentId}/inbox/{inboxItemId}/acceptances",
      "/v0/agents/{agentId}/work-item-inbox",
      "/v0/agents/{agentId}/work-item-inbox/{inboxItemId}/acknowledgements",
      "/v0/agents/{agentId}/tasks/{taskId}/finish-admissions",
      "/v0/mcp-grants/authorize",
    ]) {
      expect(teamhubInternal.paths).not.toHaveProperty(path);
    }
    expect(teamhubInternal.components?.securitySchemes).not.toHaveProperty(
      "runBearer",
    );
    for (const schemaName of [
      "OpenRunRequest",
      "OpenRunResponse",
      "RunEventEnvelope",
      "RunEvent",
      "RunCompletedEventPayload",
      "RunTerminalEvent",
      "RunInputArtifact",
      "DocumentRevisionInput",
      "RunDocumentAssetManifestEntry",
      "AgentInboxItem",
      "AgentInboxAcceptanceResult",
      "AgentWorkItemInboxItem",
      "RequestAgentInvocationRequest",
      "RequestAgentInvocationResponse",
      "AgentRunAdmitted",
      "AgentInvocationRejected",
      "AppendRunSteerContextRequest",
      "AppendRunSteerContextResult",
      "ReconcileRunRequest",
      "ReconcileRunResult",
    ]) {
      expect(schemas(teamhubInternal)).not.toHaveProperty(schemaName);
    }
  });
});

describe("Agent Run completion contracts", () => {
  it("models ordered events and has no Task finish result slot", () => {
    const callbackSchemas = schemas(teamhubInternal);
    for (const schemaName of [
      "StageRunOutputMetadata",
      "StagedRunOutput",
      "UpdateExistingPublication",
      "CreateNewPublication",
      "VersionChangedConflict",
      "TargetExistsConflict",
      "BatchPathConflict",
      "TargetDeletedConflict",
      "ArtifactPublicationConflictResult",
    ]) {
      expect(callbackSchemas).not.toHaveProperty(schemaName);
    }
    // A delegated Task reports through its Run's final reply.
    for (const contract of [teamhubInternal, teamhubAgentApi])
      expect(contract.paths).not.toHaveProperty(
        "/api/agent/v1/tasks/{taskId}/finish",
      );
    expect(callbackSchemas).not.toHaveProperty("AgentTaskFinishResult");
    expect(callbackSchemas).not.toHaveProperty("AgentTaskFinishEnvelope");
  });
});

describe("Agent Run contract boundaries", () => {
  it("keeps native Computer tool scope explicit and service-authenticated", () => {
    const call =
      nodeServicesInternal.paths?.["/v1/local-computer-tools:call"]?.post;
    expect(call?.security).toEqual([{ agentManagementBearer: [] }]);
    expect(
      nodeServicesInternal.components?.schemas?.LocalComputerToolCall?.required,
    ).toEqual(
      expect.arrayContaining([
        "tenant_id",
        "owner_actor_id",
        "agent_id",
        "computer_id",
        "tool_session_id",
      ]),
    );
  });
  it("keeps TeamHub authority fields out of Agent Run wire contracts", () => {
    for (const contract of [
      agentRunBoundaryManagement,
      agentRunBoundaryCallback,
    ]) {
      const serialized = JSON.stringify(contract);
      for (const hiddenField of [
        "tenant_id",
        "delivery_id",
        "agent_actor_id",
        "assignment_actor_id",
        "agent_management_id",
        "command_id",
        "start_command_id",
      ]) {
        expect(serialized).not.toContain(`"${hiddenField}"`);
      }
    }
  });

  it("rejects unknown fields in every new object schema", () => {
    expectStrictObject(agentManagement, [
      "CancelAgentRunRequest",
      "CancelAgentRunResult",
    ]);
  });

  it("does not expose internal Run operations to Product Clients", () => {
    const publicOperationIds = Object.values(teamhubPublic.paths ?? {}).flatMap(
      (path) => Object.values(path).map((operation) => operation.operationId),
    );
    expect(publicOperationIds).not.toEqual(
      expect.arrayContaining([
        "startAgentRun",
        "cancelAgentRun",
        "requestAgentInvocation",
        "openRun",
        "reportRunEvent",
        "downloadRunArtifact",
        "confirmRunArtifactRead",
        "stageRunOutput",
      ]),
    );
  });

  it("uses Tenant-free fields for every Agent-facing product response", () => {
    const callbackSchemas = schemas(agentCallback);
    const projectionNames = [
      "AgentActorRef",
      "AgentIdentity",
      "AgentWorkItem",
      "AgentWorkItemPage",
      "AgentWorkItemComment",
      "AgentWorkItemCommentPage",
    ];
    expectStrictObject(agentCallback, projectionNames);
    for (const schemaName of projectionNames) {
      expect(
        callbackSchemas[schemaName]?.properties,
        schemaName,
      ).not.toHaveProperty("tenant_id");
    }
  });
});
