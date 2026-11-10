import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createMemoryInternalClient,
  MEMORY_INTERNAL_AUDIENCE,
  PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN,
  type MemoryInternalFetch,
} from "@linger/wire-contracts/node-services-internal/client";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Schema {
  additionalProperties?: boolean;
  const?: string | number;
  enum?: string[];
  format?: string;
  items?: Schema | { $ref: string };
  maxItems?: number;
  maximum?: number;
  maxLength?: number;
  minimum?: number;
  minItems?: number;
  minLength?: number;
  nullable?: boolean;
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  type?: string;
}

interface MemoryContract {
  security?: Array<Record<string, string[]>>;
  paths?: Record<
    string,
    {
      post?: {
        operationId?: string;
        requestBody?: {
          content?: { "application/json"?: { schema?: { $ref?: string } } };
        };
        security?: Array<Record<string, string[]>>;
        "x-deadline-ms"?: number;
      };
      get?: {
        operationId?: string;
        security?: Array<Record<string, string[]>>;
      };
      put?: { security?: Array<Record<string, string[]>> };
    }
  >;
  components?: {
    schemas?: Record<string, Schema>;
    securitySchemes?: Record<
      string,
      { scheme?: string; type?: string; "x-service-audience"?: string }
    >;
  };
}

// Operations that came from the former standalone Memory contract. Its own
// /healthz and /readyz were folded into the shared LLM Wiki host probes.
const memoryOperations = [
  ["/internal/v1/query", "post", "queryPersonalKnowledge"],
  [
    "/internal/v1/personal-knowledge/evidence",
    "post",
    "readPersonalKnowledgeEvidence",
  ],
  ["/internal/v1/memory/entries", "get", "listMemoryEntries"],
  ["/internal/v1/memory/entries/{entry_id}", "get", "getMemoryEntry"],
  [
    "/internal/v1/personal-knowledge-graph-visualization",
    "post",
    "getPersonalKnowledgeGraphVisualization",
  ],
  [
    "/internal/v1/published-wiki-graph-updates",
    "post",
    "updateGraphForPublishedWiki",
  ],
  ["/internal/v1/health/failures", "get", "getMemoryFailureSummary"],
  ["/internal/v1/health/failures:retry", "post", "retryMemoryFailures"],
  ["/internal/v1/rebuild", "get", "getMemoryRebuild"],
  ["/internal/v1/rebuild", "post", "startMemoryRebuild"],
] as const;

describe("Memory internal contract", () => {
  it("shares the opaque evidence ID protocol across query, read and runtime validation", async () => {
    const api = parse(
      await readFile(
        resolve(
          import.meta.dirname,
          "../openapi/node-services-internal/openapi.yaml",
        ),
        "utf8",
      ),
    ) as MemoryContract;
    const schemas = api.components?.schemas ?? {};
    expect(schemas.PersonalKnowledgeEvidenceId).toMatchObject({
      type: "string",
      pattern: PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN.source,
    });
    for (const [schema, property] of [
      ["PersonalKnowledgeEvidenceItem", "id"],
      ["PersonalKnowledgeEvidenceReadRequest", "evidence_id"],
      ["PersonalKnowledgeEvidenceReadResponse", "evidenceId"],
    ] as const) {
      expect(schemas[schema]?.properties?.[property]).toEqual({
        $ref: "#/components/schemas/PersonalKnowledgeEvidenceId",
      });
    }
    for (const evidenceId of [`raw_${"a".repeat(16)}_${"b".repeat(16)}`]) {
      expect(PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN.test(evidenceId)).toBe(
        true,
      );
    }
    for (const evidenceId of [
      "ev_0123456789abcdef01234567",
      "raw_1_2",
      `raw_${"a".repeat(64)}`,
      `raw_${"a".repeat(64)}_${"b".repeat(64)}`,
      `raw_${"A".repeat(64)}_${"b".repeat(64)}`,
      "../../memory/secret.md",
    ]) {
      expect(PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN.test(evidenceId)).toBe(
        false,
      );
    }
  });

  it("freezes the authenticated query and workspace source response", async () => {
    const api = parse(
      await readFile(
        resolve(
          import.meta.dirname,
          "../openapi/node-services-internal/openapi.yaml",
        ),
        "utf8",
      ),
    ) as MemoryContract;
    const schemas = api.components?.schemas ?? {};

    for (const [path, method, operationId] of memoryOperations) {
      const operation = api.paths?.[path]?.[method];
      expect(operation?.operationId, path).toBe(operationId);
      expect(operation?.security ?? api.security, operationId).toEqual([
        { memoryBearer: [] },
      ]);
    }
    expect(api.components?.securitySchemes?.memoryBearer).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "opaque",
      "x-service-audience": MEMORY_INTERNAL_AUDIENCE,
    });
    expect(api.paths?.["/internal/v1/query"]?.post).toMatchObject({
      operationId: "queryPersonalKnowledge",
      "x-deadline-ms": 120_000,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/PersonalKnowledgeQueryRequest",
            },
          },
        },
      },
    });
    expect(
      api.paths?.["/internal/v1/personal-knowledge/evidence"]?.post,
    ).toMatchObject({
      operationId: "readPersonalKnowledgeEvidence",
      "x-deadline-ms": 120_000,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/PersonalKnowledgeEvidenceReadRequest",
            },
          },
        },
      },
    });
    // Wiki pages are sources of the one personal knowledge query.
    expect(api.paths?.["/internal/v1/openwiki-pg/query"]).toBeUndefined();
    // Tracking Items moved to TeamHub; Memory no longer serves them.
    expect(api.paths?.["/internal/v1/tracking-items:list"]).toBeUndefined();
    expect(
      api.paths?.["/internal/v1/published-wiki-graph-updates"]?.post,
    ).toMatchObject({
      operationId: "updateGraphForPublishedWiki",
      "x-deadline-ms": 900_000,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/PublishedWikiGraphUpdateRequest",
            },
          },
        },
      },
    });
    expect(
      api.paths?.["/internal/v1/personal-knowledge-graph-visualization"]?.post,
    ).toMatchObject({
      operationId: "getPersonalKnowledgeGraphVisualization",
      "x-deadline-ms": 10_000,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/PersonalKnowledgeGraphVisualizationRequest",
            },
          },
        },
      },
    });
    expect(schemas.PersonalKnowledgeGraphVisualizationRequest).toMatchObject({
      additionalProperties: false,
      required: ["owner_actor_id", "tenant_id"],
    });
    expect(schemas.PersonalKnowledgeQueryRequest).toMatchObject({
      additionalProperties: false,
      required: [
        "agent_id",
        "agent_actor_id",
        "user_artifact_owner_actor_id",
        "tenant_id",
        "query",
      ],
      properties: {
        date_from: { type: "string", format: "date" },
        date_to: { type: "string", format: "date" },
      },
    });
    expect(schemas.PersonalKnowledgeNodeType).toBeUndefined();
    expect(schemas.QuerySource).toBeUndefined();
    expect(schemas.PersonalKnowledgeQueryResponse).toMatchObject({
      additionalProperties: false,
      required: ["schemaVersion", "status", "items", "gaps", "indexedAt"],
      properties: {
        schemaVersion: { type: "integer", const: 1 },
        status: {
          type: "string",
          enum: ["grounded", "partial", "empty"],
        },
        items: {
          type: "array",
          items: {
            $ref: "#/components/schemas/PersonalKnowledgeEvidenceItem",
          },
        },
        indexedAt: { type: "string", nullable: true },
      },
    });
    expect(schemas.PersonalKnowledgeEvidenceItem).toMatchObject({
      additionalProperties: false,
      required: [
        "id",
        "citeAs",
        "title",
        "excerpt",
        "source",
        "representation",
      ],
      properties: {
        directory: {
          type: "array",
          maxItems: 64,
          items: {
            $ref: "#/components/schemas/PersonalKnowledgeSectionDirectoryEntry",
          },
        },
      },
    });
    expect(schemas.PersonalKnowledgeSectionDirectoryEntry).toMatchObject({
      additionalProperties: false,
      required: ["id", "title", "level"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[a-z0-9][a-z0-9_-]*$",
        },
        title: { type: "string", minLength: 1, maxLength: 512 },
        level: { type: "integer", minimum: 1, maximum: 6 },
        purpose: { type: "string", minLength: 1, maxLength: 512 },
      },
    });
    expect(schemas.PersonalKnowledgeEvidenceReadRequest).toMatchObject({
      additionalProperties: false,
      required: [
        "agent_id",
        "agent_actor_id",
        "user_artifact_owner_actor_id",
        "tenant_id",
        "evidence_id",
        "section_requests",
      ],
      properties: {
        evidence_id: {
          $ref: "#/components/schemas/PersonalKnowledgeEvidenceId",
        },
        section_requests: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            $ref: "#/components/schemas/PersonalKnowledgeSectionReadRequest",
          },
        },
      },
    });
    expect(schemas.PersonalKnowledgeSectionReadRequest).toMatchObject({
      additionalProperties: false,
      required: ["section_id"],
      properties: {
        section_id: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[a-z0-9][a-z0-9_-]*$",
        },
        offset: { type: "integer", minimum: 0, maximum: 200_000 },
      },
    });
    expect(schemas.PersonalKnowledgeEvidenceReadResponse).toMatchObject({
      additionalProperties: false,
      required: [
        "schemaVersion",
        "evidenceId",
        "title",
        "source",
        "directory",
        "sections",
        "missingSections",
        "complete",
      ],
      properties: {
        schemaVersion: { type: "integer", const: 1 },
        evidenceId: {
          $ref: "#/components/schemas/PersonalKnowledgeEvidenceId",
        },
        directory: {
          type: "array",
          maxItems: 64,
          items: {
            $ref: "#/components/schemas/PersonalKnowledgeSectionDirectoryEntry",
          },
        },
        sections: {
          type: "array",
          maxItems: 8,
          items: {
            $ref: "#/components/schemas/PersonalKnowledgeEvidenceSection",
          },
        },
        missingSections: {
          type: "array",
          maxItems: 8,
          items: { type: "string", maxLength: 128 },
        },
        complete: { type: "boolean" },
      },
    });
    expect(schemas.PersonalKnowledgeEvidenceSection).toMatchObject({
      additionalProperties: false,
      required: ["id", "title", "level", "content", "offset", "truncated"],
      properties: {
        content: { type: "string", maxLength: 12_000 },
        offset: { type: "integer", minimum: 0, maximum: 200_000 },
        truncated: { type: "boolean" },
        nextOffset: { type: "integer", minimum: 1, maximum: 200_000 },
      },
    });
    expect(schemas.PersonalKnowledgeEvidenceSource).toMatchObject({
      additionalProperties: false,
      required: ["kind", "ref"],
    });
    expect(schemas.PersonalKnowledgeEvidenceGap).toMatchObject({
      additionalProperties: false,
      required: ["code"],
    });
  });

  it("sends the exact query with the Memory workload audience", async () => {
    const requests: Request[] = [];
    const audiences: string[] = [];
    const fetch: MemoryInternalFetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        gaps: [],
        indexedAt: "2026-09-01T12:00:00Z",
        items: [
          {
            citeAs: "S1",
            excerpt: "Filesystem-first",
            id: `raw_${"a".repeat(16)}_${"b".repeat(16)}`,
            representation: "source_excerpt",
            source: {
              kind: "raw",
              ref: `raw_${"a".repeat(16)}_${"b".repeat(16)}`,
            },
            title: "Memory",
          },
        ],
        schemaVersion: 1,
        status: "grounded",
      });
    };
    const client = createMemoryInternalClient({
      baseUrl: "https://memory.example.test",
      fetch,
      getAccessToken: ({ audience }) => {
        audiences.push(audience);
        return "memory-token";
      },
    });
    const body = {
      agent_actor_id: "actor_agent_1",
      agent_id: "agent_1",
      query: "What is the plan?",
      tenant_id: "tenant_1",
      user_artifact_owner_actor_id: "human_1",
    };

    await expect(client.query(body)).resolves.toEqual({
      gaps: [],
      indexedAt: "2026-09-01T12:00:00Z",
      items: [
        {
          citeAs: "S1",
          excerpt: "Filesystem-first",
          id: `raw_${"a".repeat(16)}_${"b".repeat(16)}`,
          representation: "source_excerpt",
          source: {
            kind: "raw",
            ref: `raw_${"a".repeat(16)}_${"b".repeat(16)}`,
          },
          title: "Memory",
        },
      ],
      schemaVersion: 1,
      status: "grounded",
    });
    expect(audiences).toEqual([MEMORY_INTERNAL_AUDIENCE]);
    expect(requests[0]?.url).toBe(
      "https://memory.example.test/internal/v1/query",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer memory-token",
    );
    await expect(requests[0]?.json()).resolves.toEqual(body);
  });

  it("reads selected Raw chunks with the Memory workload audience", async () => {
    const requests: Request[] = [];
    const audiences: string[] = [];
    const fetch: MemoryInternalFetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        complete: false,
        directory: [
          {
            id: "action_items",
            level: 2,
            purpose: "Explicit owners and follow-ups",
            title: "Action Items",
          },
        ],
        evidenceId: `raw_${"a".repeat(16)}_${"b".repeat(16)}`,
        missingSections: [],
        schemaVersion: 1,
        sections: [
          {
            content: "- Alice: send the first ID proposal this week.",
            id: "action_items",
            level: 2,
            nextOffset: 52,
            offset: 0,
            title: "Action Items",
            truncated: true,
          },
        ],
        source: { kind: "raw", ref: `raw_${"a".repeat(16)}_${"b".repeat(16)}` },
        timeHint: "2026-09-09",
        title: "Audio and AI hardware partnership",
      });
    };
    const client = createMemoryInternalClient({
      baseUrl: "https://memory.example.test",
      fetch,
      getAccessToken: ({ audience }) => {
        audiences.push(audience);
        return "memory-token";
      },
      timeoutMs: 9_876,
    });
    const body = {
      agent_actor_id: "actor_agent_1",
      agent_id: "agent_1",
      evidence_id: `raw_${"a".repeat(16)}_${"b".repeat(16)}`,
      section_requests: [{ offset: 0, section_id: "action_items" }],
      tenant_id: "tenant_1",
      user_artifact_owner_actor_id: "human_1",
    };

    await expect(client.readEvidence(body)).resolves.toMatchObject({
      complete: false,
      evidenceId: `raw_${"a".repeat(16)}_${"b".repeat(16)}`,
      sections: [
        {
          id: "action_items",
          nextOffset: 52,
          truncated: true,
        },
      ],
    });
    expect(audiences).toEqual([MEMORY_INTERNAL_AUDIENCE]);
    expect(requests[0]?.url).toBe(
      "https://memory.example.test/internal/v1/personal-knowledge/evidence",
    );
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer memory-token",
    );
    await expect(requests[0]?.json()).resolves.toEqual(body);
  });

  it("sends one published Wiki graph update command", async () => {
    const requests: Request[] = [];
    const client = createMemoryInternalClient({
      baseUrl: "https://memory.example.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 204 });
      },
      getAccessToken: () => "teamhub-memory-token",
    });
    const update = {
      owner_actor_id: "actor_alice",
      wiki_revision_id: "revision_2",
    };

    await expect(
      client.updateGraphForPublishedWiki(update),
    ).resolves.toBeUndefined();
    expect(requests[0]?.url).toBe(
      "https://memory.example.test/internal/v1/published-wiki-graph-updates",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer teamhub-memory-token",
    );
    await expect(requests[0]?.json()).resolves.toEqual(update);
  });

  it("keeps Memory-to-TeamHub Wiki projection on its own workload credential", async () => {
    const api = parse(
      await readFile(
        resolve(
          import.meta.dirname,
          "../openapi/teamhub-internal/openapi.yaml",
        ),
        "utf8",
      ),
    ) as MemoryContract;

    expect(api.components?.securitySchemes?.memoryServiceBearer).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "opaque Memory service token",
      "x-service-audience": "teamhub-memory-internal",
    });
    expect(
      api.paths?.["/v0/personal-wikis/{actorId}/document-revision"]?.get
        ?.security,
    ).toEqual([{ memoryServiceBearer: [] }]);
    expect(
      api.paths?.[
        "/v0/personal-wikis/{actorId}/document-revisions/{wikiRevisionId}/documents/{documentId}/versions/{documentVersionId}/content"
      ]?.get?.security,
    ).toEqual([{ memoryServiceBearer: [] }]);
  });
});
