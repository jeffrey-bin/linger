import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  createTeamHubMcpInternalClient,
  type TeamHubMcpInternalFetch,
} from "../generated/typescript/src/teamhub-internal/client.js";

interface Schema {
  $ref?: string;
  additionalProperties?: boolean;
  allOf?: Schema[];
  const?: boolean | string;
  description?: string;
  discriminator?: { mapping?: Record<string, string>; propertyName?: string };
  enum?: string[];
  format?: string;
  items?: Schema;
  maxItems?: number;
  maxLength?: number;
  maximum?: number;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  oneOf?: Schema[];
  nullable?: boolean;
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  type?: string;
  uniqueItems?: boolean;
  writeOnly?: boolean;
  "x-sensitive"?: boolean;
  "x-unique-by"?: string;
}

interface Operation {
  description?: string;
  operationId?: string;
  requestBody?: {
    content?: { "application/json"?: { schema?: Schema } };
  };
  responses?: Record<
    string,
    {
      $ref?: string;
      content?: { "application/json"?: { schema?: Schema } };
    }
  >;
  security?: Array<Record<string, string[]>>;
  "x-deadline-ms"?: number;
}

interface OpenApiDocument {
  security?: Array<Record<string, string[]>>;
  paths?: Record<
    string,
    {
      get?: Operation;
      post?: Operation;
    }
  >;
  components?: {
    securitySchemes?: Record<
      string,
      {
        type?: string;
        scheme?: string;
        "x-service-audience"?: string;
      }
    >;
  };
}

interface ComponentDocument {
  components?: {
    schemas?: Record<string, Schema>;
    responses?: Record<string, unknown>;
  };
}

const openApiRoot = resolve(import.meta.dirname, "../openapi");

async function readYaml<T>(path: string): Promise<T> {
  return parse(await readFile(resolve(openApiRoot, path), "utf8")) as T;
}

describe("TeamHub MCP Context contract", () => {
  it("binds a meta Context only to its Room", async () => {
    const component = await readYaml<ComponentDocument>(
      "components/mcp-context-internal.yaml",
    );
    const reference = component.components?.schemas?.MetaMcpContextReference;

    expect(reference).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["kind", "room_id"],
      properties: { kind: { type: "string", const: "meta" } },
    });
    for (const field of [
      "invocation_id",
      "beneficiary_actor_id",
      "document_id",
      "revision_id",
    ]) {
      expect(reference?.properties).not.toHaveProperty(field);
    }
  });

  it("resolves Contexts without Document pins, inputs, or downloads", async () => {
    const api = await readYaml<OpenApiDocument>(
      "teamhub-internal/openapi.yaml",
    );
    const component = await readYaml<ComponentDocument>(
      "components/mcp-context-internal.yaml",
    );
    const schemas = component.components?.schemas ?? {};

    expect(schemas.McpContextResolveResponse).toMatchObject({
      additionalProperties: false,
      required: ["agent_id", "context"],
    });
    for (const field of [
      "context_session_id",
      "context_session_expires_at",
      "context_generation_id",
      "document_pins",
      "document_inputs",
      "document_action_authority",
    ]) {
      expect(schemas.McpContextResolveResponse?.properties).not.toHaveProperty(
        field,
      );
    }
    expect(schemas.DocumentMcpContextReference?.properties).not.toHaveProperty(
      "invocation_id",
    );
    for (const name of [
      "McpDocumentContextPin",
      "McpDocumentContextInput",
      "McpDocumentActionAuthority",
      "McpContextDocumentPinContentRequest",
    ]) {
      expect(schemas).not.toHaveProperty(name);
    }
    expect(Object.keys(api.paths ?? {})).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("/mcp-context/document-"),
      ]),
    );
  });

  it("locks the live Context authorization fields without sessions", async () => {
    const component = await readYaml<ComponentDocument>(
      "components/mcp-context-internal.yaml",
    );
    const schemas = component.components?.schemas ?? {};

    expect(schemas.McpContextReference).toMatchObject({
      discriminator: {
        propertyName: "kind",
        mapping: {
          meta: "#/components/schemas/MetaMcpContextReference",
          alter_ego: "#/components/schemas/AlterEgoMcpContextReference",
          document: "#/components/schemas/DocumentMcpContextReference",
        },
      },
      oneOf: [
        { $ref: "#/components/schemas/MetaMcpContextReference" },
        { $ref: "#/components/schemas/AlterEgoMcpContextReference" },
        { $ref: "#/components/schemas/DocumentMcpContextReference" },
      ],
    });
    expect(schemas.MetaMcpContextReference).toMatchObject({
      additionalProperties: false,
      required: ["kind", "room_id"],
      properties: { kind: { const: "meta" } },
    });
    expect(schemas.AlterEgoMcpContextReference).toMatchObject({
      additionalProperties: false,
      required: ["kind", "task_id"],
      properties: { kind: { const: "alter_ego" } },
    });
    expect(schemas.DocumentMcpContextReference).toMatchObject({
      additionalProperties: false,
      required: ["kind", "document_id"],
      properties: {
        kind: { const: "document" },
        document_id: { $ref: "./common.yaml#/components/schemas/Id" },
      },
    });
    expect(schemas.McpContextResolveRequest).toMatchObject({
      additionalProperties: false,
      required: ["context"],
    });
    expect(schemas.McpContextResolveRequest?.properties).not.toHaveProperty(
      "context_generation",
    );
    for (const field of ["binding_version", "servers"]) {
      expect(schemas.McpContextResolveResponse?.properties).not.toHaveProperty(
        field,
      );
    }
    for (const name of [
      "McpResolvedServer",
      "McpResolvedServerAuth",
      "McpServerAuthMode",
      "McpAllowedTools",
    ]) {
      expect(schemas).not.toHaveProperty(name);
    }
    for (const name of [
      "McpContextSessionId",
      "McpContextRevokeRequest",
      "McpContextRevokeResponse",
    ]) {
      expect(schemas).not.toHaveProperty(name);
    }
    expect(schemas.McpContextErrorCode?.enum).toEqual([
      "invalid_request",
      "unauthenticated",
      "context_identity_invalid",
      "dependency_unavailable",
      "internal_error",
    ]);

    for (const name of [
      "MetaMcpContextReference",
      "AlterEgoMcpContextReference",
      "McpContextResolveRequest",
      "McpContextResolveResponse",
    ]) {
      expect(schemas[name]?.additionalProperties, name).toBe(false);
    }
  });

  it("limits persisted and Human-creatable Agent types to current types and requires strict Skill SemVer", async () => {
    const [domain, common] = await Promise.all([
      readYaml<ComponentDocument>("components/domain.yaml"),
      readYaml<ComponentDocument>("components/common.yaml"),
    ]);
    const domainSchemas = domain.components?.schemas ?? {};
    const commonSchemas = common.components?.schemas ?? {};

    expect(domainSchemas.AgentType?.enum).toEqual(["general", "anotherme"]);
    expect(domainSchemas.CreatableAgentType?.enum).toEqual(["general"]);
    expect(domainSchemas).not.toHaveProperty("AgentTypeCatalog");
    expect(
      domainSchemas.TenantAgentCreateRequest?.properties?.agent_type,
    ).toEqual({
      $ref: "#/components/schemas/CreatableAgentType",
      description:
        "Defaults to general for compatibility with existing clients.",
    });
    expect(domainSchemas.TenantAgent?.properties?.agent_type).toEqual({
      $ref: "#/components/schemas/AgentType",
    });

    const manifestVersion = commonSchemas.ManifestVersion;
    const pattern = new RegExp(manifestVersion?.pattern ?? "");
    for (const valid of ["0.0.0", "1.0.0-alpha.13", "2.7.11+build.5"]) {
      expect(valid).toMatch(pattern);
    }
    for (const invalid of ["1", "1.0", "01.0.0", "1.0.0-"]) {
      expect(invalid).not.toMatch(pattern);
    }
  });

  it("uses the exact nested error envelope on every shared error response", async () => {
    const component = await readYaml<ComponentDocument>(
      "components/mcp-context-internal.yaml",
    );
    const schemas = component.components?.schemas ?? {};

    expect(schemas.McpContextErrorEnvelope).toMatchObject({
      additionalProperties: false,
      required: ["error"],
      properties: {
        error: {
          $ref: "#/components/schemas/McpContextError",
        },
      },
    });
    expect(schemas.McpContextError).toMatchObject({
      additionalProperties: false,
      required: ["code", "message", "request_id"],
      properties: {
        issues: {
          minItems: 1,
          maxItems: 100,
          items: {
            $ref: "#/components/schemas/McpContextErrorIssue",
          },
        },
      },
    });
    expect(schemas.McpContextErrorIssue).toMatchObject({
      additionalProperties: false,
      required: ["path", "code", "message"],
    });
    expect(Object.keys(component.components?.responses ?? {}).sort()).toEqual(
      [
        "McpContextBadRequest",
        "McpContextConflict",
        "McpContextForbidden",
        "McpContextInternalError",
        "McpContextNotFound",
        "McpContextUnauthenticated",
      ].sort(),
    );
  });
});

it("keeps the MCP Context control plane on the Agent Service workload credential", async () => {
  const api = await readYaml<OpenApiDocument>("teamhub-internal/openapi.yaml");
  expect(api.components?.securitySchemes?.agentServiceToTeamHubBearer).toEqual(
    expect.objectContaining({
      "x-service-audience": "teamhub-agent-callback",
    }),
  );
  const mcpContextPaths = Object.keys(api.paths ?? {}).filter((path) =>
    path.includes("/mcp-context/"),
  );
  expect(mcpContextPaths.sort()).toEqual([
    "/internal/agents/{agentId}/mcp-context/actions/resolve",
  ]);
  for (const path of mcpContextPaths) {
    const item = api.paths?.[path];
    expect(item?.get, path).toBeUndefined();
    expect(item?.post?.security ?? api.security, path).toEqual([
      { agentServiceToTeamHubBearer: [] },
    ]);
  }
  const requests: Array<{ url: string; token: string | null; body: unknown }> =
    [];
  const client = createTeamHubMcpInternalClient({
    baseUrl: "https://teamhub.test",
    getAccessToken: () => "runtime-service-identity",
    fetch: (async (url, init) => {
      requests.push({
        url: String(url),
        token: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({});
    }) as TeamHubMcpInternalFetch,
  });
  await client.resolveMcpContext("agent_1", {
    context: { kind: "document", document_id: "document_1" },
  });
  expect(requests).toEqual([
    {
      url: "https://teamhub.test/internal/agents/agent_1/mcp-context/actions/resolve",
      token: "Bearer runtime-service-identity",
      body: { context: { kind: "document", document_id: "document_1" } },
    },
  ]);
});
