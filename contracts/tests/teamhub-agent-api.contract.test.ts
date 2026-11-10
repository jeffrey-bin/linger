import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

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

describe("TeamHub Agent API contract", () => {
  it("separates Creation caller input from the frozen effective payload", async () => {
    const component = await readYaml<ComponentDocument>(
      "components/agent-collaboration.yaml",
    );
    const schemas = component.components?.schemas ?? {};

    expect(schemas.AgentCreationMessageSegment).toMatchObject({
      discriminator: {
        propertyName: "type",
        mapping: {
          text: "#/components/schemas/AgentTextMessageSegment",
          reference: "#/components/schemas/AgentReferenceMessageSegment",
        },
      },
      oneOf: [
        { $ref: "#/components/schemas/AgentTextMessageSegment" },
        { $ref: "#/components/schemas/AgentReferenceMessageSegment" },
      ],
    });
    expect(
      schemas.AgentCreationMessageSegment?.discriminator?.mapping,
    ).not.toHaveProperty("file");
    expect(schemas.AgentCreationMessageSegments).toMatchObject({
      minItems: 1,
      maxItems: 1_000,
      items: { $ref: "#/components/schemas/AgentCreationMessageSegment" },
    });

    // Tasks are delegated directly; only Room creation needs approval.
    for (const retired of [
      "AgentCreationApprovalRequest",
      "AgentTaskCreationApprovalRequest",
      "AgentTaskCreationCallerInput",
      "AgentTaskCreationEffectivePayload",
      "AgentTaskCreationActorResolveRequest",
      "AgentResolvedTaskCreationActor",
      "AgentTaskCreationActorResolveResponse",
    ]) {
      expect(schemas).not.toHaveProperty(retired);
    }
    expect(schemas.AgentRoomCreationApprovalRequest).toMatchObject({
      additionalProperties: false,
      required: [
        "request_kind",
        "invocation_id",
        "caller_input",
        "effective_payload",
      ],
      properties: {
        request_kind: { const: "room_creation" },
        caller_input: {
          $ref: "#/components/schemas/AgentRoomCreationCallerInput",
        },
        effective_payload: {
          $ref: "#/components/schemas/AgentRoomCreationEffectivePayload",
        },
      },
    });
    for (const forbidden of [
      "agent_id",
      "agent_actor_id",
      "caller_id",
      "human_id",
      "origin_room_id",
      "tenant_id",
    ]) {
      expect(
        schemas.AgentRoomCreationApprovalRequest?.properties,
      ).not.toHaveProperty(forbidden);
    }

    expect(schemas.AgentRoomCreationCallerInput).toMatchObject({
      additionalProperties: false,
      required: ["name", "member_ids", "initial_message_segments"],
    });
    expect(schemas.AgentRoomCreationEffectivePayload).toMatchObject({
      additionalProperties: false,
      required: ["name", "member_ids", "initial_message_segments"],
    });
    expect(schemas.AgentPlaygroundFilePath).toMatchObject({
      type: "string",
      minLength: 14,
      maxLength: 1_037,
      pattern: expect.stringContaining("^\\./playground/"),
    });
    for (const schemaName of [
      "AgentRoomCreationCallerInput",
      "AgentRoomCreationEffectivePayload",
    ]) {
      expect(schemas[schemaName]?.properties).not.toHaveProperty(
        "origin_room_id",
      );
    }
    expect(schemas.AgentCreationActorIds).toMatchObject({
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    });
    expect(schemas).not.toHaveProperty("AgentCreationCausationMessageIds");

    expect(schemas.AgentCreationApprovalResponse).toMatchObject({
      additionalProperties: false,
      required: [
        "accepted",
        "status",
        "creation_approval_request_id",
        "message_id",
      ],
      properties: {
        accepted: { const: true },
        status: { const: "pending_approval" },
      },
    });
    expect(
      Object.keys(
        schemas.AgentCreationApprovalResponse?.properties ?? {},
      ).sort(),
    ).toEqual(
      [
        "accepted",
        "status",
        "creation_approval_request_id",
        "message_id",
      ].sort(),
    );

    expect(schemas.AgentCreateTaskRequest).toMatchObject({
      additionalProperties: false,
      required: ["invocation_id", "name", "requirement"],
    });
    for (const name of [
      "AgentCheckTaskRequest",
      "AgentCheckTaskResponse",
      "AgentTaskDetail",
      "AgentSendTaskRequest",
      "AgentStopTaskRequest",
    ]) {
      expect(schemas[name]?.additionalProperties, name).toBe(false);
    }
  });

  it("locks Agent invocation and message request shapes", async () => {
    const collaboration = await readYaml<ComponentDocument>(
      "components/agent-collaboration.yaml",
    );
    const collaborationSchemas = collaboration.components?.schemas ?? {};
    expect(collaborationSchemas.AgentInvocationId).toMatchObject({
      minLength: 88,
      maxLength: 88,
      pattern: "^agent-invocation-sha256:[a-f0-9]{64}$",
    });
    expect(collaborationSchemas.AgentSendDirectMessageRequest).toMatchObject({
      additionalProperties: false,
      required: ["invocation_id", "messages"],
      properties: {
        messages: {
          minItems: 1,
          maxItems: 100,
          items: { minLength: 1, maxLength: 50_000 },
        },
      },
    });
    expect(collaborationSchemas.AgentSendDirectMessageResponse).toMatchObject({
      additionalProperties: false,
      required: [
        "duplicate_request",
        "accepted",
        "inbox_id",
        "message_ids",
        "room_created",
      ],
      properties: {
        accepted: { const: true },
        inbox_id: { pattern: "^room:[A-Za-z0-9][A-Za-z0-9_-]*$" },
        message_ids: { minItems: 1, maxItems: 100 },
      },
    });
    expect(collaborationSchemas).not.toHaveProperty("AgentMetaInboxId");
    // Only the retired Meta and AlterEgo private messages sent JSON segments.
    for (const name of [
      "AgentMessageSegment",
      "AgentMessageSegments",
      "AgentFileMessageSegment",
      "AgentDocumentMessageSegment",
    ]) {
      expect(collaborationSchemas).not.toHaveProperty(name);
    }
    expect(collaborationSchemas).not.toHaveProperty(
      "AgentSendMessageSourceInboxIds",
    );
    expect(collaborationSchemas).not.toHaveProperty(
      "AgentSendMessageCausationMessageIds",
    );
    for (const name of [
      "AgentTextMessageSegment",
      "AgentReferenceMessageSegment",
    ]) {
      expect(collaborationSchemas[name]?.additionalProperties, name).toBe(
        false,
      );
      expect(collaborationSchemas[name]?.description, name).toBeTruthy();
    }
    // A Task's AlterEgo reports through its final reply.
    for (const retired of [
      "AgentSendToAlterEgoRequest",
      "AgentSendToAlterEgoResponse",
      "AgentSendToMetaRequest",
      "AgentSendToMetaResponse",
    ]) {
      expect(collaborationSchemas).not.toHaveProperty(retired);
    }
  });

  it("uses one exact nested error envelope on every Agent API error response", async () => {
    const component = await readYaml<ComponentDocument>(
      "components/agent-api-errors.yaml",
    );
    const schemas = component.components?.schemas ?? {};

    expect(schemas.AgentApiErrorEnvelope).toMatchObject({
      additionalProperties: false,
      required: ["error"],
      properties: {
        error: { $ref: "#/components/schemas/AgentApiError" },
      },
    });
    expect(schemas.AgentApiError).toMatchObject({
      additionalProperties: false,
      required: ["code", "message", "request_id"],
      properties: {
        issues: {
          minItems: 1,
          maxItems: 100,
          items: { $ref: "#/components/schemas/AgentApiErrorIssue" },
        },
      },
    });
    for (const code of [
      "agent_credential_invalid",
      "operation_forbidden",
      "idempotency_conflict",
      "version_conflict",
    ]) {
      expect(schemas.AgentApiErrorCode?.enum).toContain(code);
    }
    expect(schemas.AgentApiErrorCode?.enum).not.toContain(
      "mcp_context_invalid",
    );
    expect(Object.keys(component.components?.responses ?? {}).sort()).toEqual(
      [
        "BadRequest",
        "Conflict",
        "Forbidden",
        "InternalError",
        "NotFound",
        "PayloadTooLarge",
        "ServiceUnavailable",
        "TooManyRequests",
        "Unauthenticated",
      ].sort(),
    );
  });

  it("serves only Agent-credential business routes", async () => {
    const api = await readYaml<OpenApiDocument>(
      "teamhub-agent-api/openapi.yaml",
    );
    expect(api.components?.securitySchemes).toEqual({
      agentBearer: expect.objectContaining({
        "x-service-audience": "teamhub-agent",
      }),
    });
    const routes = Object.keys(api.paths ?? {});
    expect(routes.length).toBeGreaterThan(0);
    expect(
      routes.filter((route) => !route.startsWith("/api/agent/v1/")),
    ).toEqual([]);
  });
});
