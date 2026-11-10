import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Schema {
  additionalProperties?: boolean;
  const?: string;
  enum?: string[];
  properties?: Record<string, unknown>;
  required?: string[];
  type?: string;
}

interface ComponentDocument {
  components?: { schemas?: Record<string, Schema> };
}

interface OpenApiDocument {
  paths?: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        security?: Array<Record<string, string[]>>;
        requestBody?: {
          content?: Record<string, { schema?: { $ref?: string } }>;
        };
        responses?: Record<
          string,
          { content?: Record<string, { schema?: { $ref?: string } }> }
        >;
        "x-deadline-ms"?: number;
        "x-max-request-body-bytes"?: number;
      }
    >
  >;
}

const openApiRoot = resolve(import.meta.dirname, "../openapi");

const readYaml = async <T>(path: string): Promise<T> =>
  parse(await readFile(resolve(openApiRoot, path), "utf8")) as T;

describe("unified Document semantic mutation fixed gateway", () => {
  it("exposes one Agent-authenticated bounded command without authority overrides", async () => {
    const api = await readYaml<OpenApiDocument>(
      "teamhub-agent-api/openapi.yaml",
    );
    const operation =
      api.paths?.["/api/agent/v1/document-semantic-mutations"]?.post;
    expect(operation).toMatchObject({
      operationId: "applyAgentDocumentSemanticMutation",
      security: [{ agentBearer: [] }],
      "x-deadline-ms": 35_000,
      "x-max-request-body-bytes": 263_168,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              $ref: "../components/agent-collaboration.yaml#/components/schemas/AgentDocumentSemanticMutationRequest",
            },
          },
        },
      },
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                $ref: "../components/agent-collaboration.yaml#/components/schemas/AgentDocumentSemanticMutationResponse",
              },
            },
          },
        },
      },
    });
  });

  it("requires a document ID without allowing authority overrides", async () => {
    const component = await readYaml<ComponentDocument>(
      "components/agent-collaboration.yaml",
    );
    const schemas = component.components?.schemas ?? {};
    expect(schemas.AgentDocumentSemanticMutationRequest).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "document_id",
        "invocation_id",
        "schema_version",
        "semantic_change",
      ],
      properties: {
        document_id: {
          $ref: "#/components/schemas/AgentDocumentAuthorityId",
        },
        invocation_id: {
          $ref: "#/components/schemas/AgentInvocationId",
        },
        schema_version: { type: "string", const: "blocknote-semantic-v1" },
        semantic_change: {
          $ref: "#/components/schemas/AgentDocumentSemanticOperations",
        },
      },
    });
    expect(schemas.AgentDocumentSemanticOperations).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 64,
      "x-max-encoded-bytes": 262144,
      items: {
        discriminator: {
          propertyName: "kind",
          mapping: {
            set_title:
              "#/components/schemas/AgentSetDocumentTitleSemanticOperation",
            insert_blocks:
              "#/components/schemas/AgentInsertDocumentBlocksSemanticOperation",
            replace_blocks:
              "#/components/schemas/AgentReplaceDocumentBlocksSemanticOperation",
            update_block:
              "#/components/schemas/AgentUpdateDocumentBlockSemanticOperation",
            delete_blocks:
              "#/components/schemas/AgentDeleteDocumentBlocksSemanticOperation",
          },
        },
      },
    });
    expect(schemas.AgentDocumentAuthorityId).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
    });
    for (const forbidden of [
      "document_path",
      "base_revision_id",
      "agent_actor_id",
      "owner_actor_id",
      "beneficiary_human_actor_id",
      "execution_context_ref",
      "context_session_id",
      "context_generation_id",
      "expected_manifest_version",
      "execution_run_ref",
      "raw_yjs_update",
    ]) {
      expect(
        schemas.AgentDocumentSemanticMutationRequest?.properties,
      ).not.toHaveProperty(forbidden);
    }
    expect(schemas.AgentDocumentSemanticMutationResponse).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["semantic_mutation_id", "status", "replayed"],
      properties: {
        status: { type: "string", enum: ["applied", "conflicted"] },
      },
    });
  });
});
