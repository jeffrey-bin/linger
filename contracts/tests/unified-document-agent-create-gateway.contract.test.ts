import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Schema {
  additionalProperties?: boolean;
  properties?: Record<string, unknown>;
  required?: string[];
  type?: string;
}

interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown>>;
}

const openApiRoot = resolve(import.meta.dirname, "../openapi");
const readYaml = async <T>(path: string): Promise<T> =>
  parse(await readFile(resolve(openApiRoot, path), "utf8")) as T;

describe("unified Document Agent create fixed gateway", () => {
  it("exposes one Agent-authenticated bounded create command", async () => {
    const api = await readYaml<OpenApiDocument>(
      "teamhub-agent-api/openapi.yaml",
    );
    expect(api.paths?.["/api/agent/v1/documents"]?.post).toMatchObject({
      operationId: "createAgentDocument",
      security: [{ agentBearer: [] }],
      "x-deadline-ms": 35_000,
      "x-max-request-body-bytes": 1_052_672,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              $ref: "../components/agent-collaboration.yaml#/components/schemas/AgentDocumentCreateRequest",
            },
          },
        },
      },
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                $ref: "../components/agent-collaboration.yaml#/components/schemas/AgentDocumentCreateResponse",
              },
            },
          },
        },
      },
    });
  });

  it("accepts content but no identity, destination, or source override", async () => {
    const component = await readYaml<{
      components?: { schemas?: Record<string, Schema> };
    }>("components/agent-collaboration.yaml");
    const schemas = component.components?.schemas ?? {};
    expect(schemas.AgentDocumentCreateRequest).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["invocation_id", "title", "markdown"],
      properties: {
        invocation_id: {
          $ref: "#/components/schemas/AgentInvocationId",
        },
        title: { type: "string", minLength: 1, maxLength: 255 },
        markdown: { type: "string", maxLength: 1048576 },
      },
    });
    for (const forbidden of [
      "document_id",
      "revision_id",
      "agent_actor_id",
      "owner_actor_id",
      "beneficiary_human_actor_id",
      "binding_kind",
      "room_id",
      "task_id",
      "source_inbox_ids",
      "execution_context_ref",
      "context_session_id",
      "context_generation_id",
      "expected_manifest_version",
      "execution_run_ref",
      "raw_yjs_update",
    ]) {
      expect(schemas.AgentDocumentCreateRequest?.properties).not.toHaveProperty(
        forbidden,
      );
    }
    expect(schemas.AgentDocumentCreateResponse).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["document_id", "revision_id", "status", "replayed"],
      properties: {
        status: { type: "string", const: "created" },
      },
    });
  });
});
