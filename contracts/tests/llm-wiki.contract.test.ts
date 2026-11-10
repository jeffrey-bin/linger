import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Schema {
  $ref?: string;
  additionalProperties?: boolean;
  const?: string;
  enum?: string[];
  format?: string;
  items?: Schema;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  type?: string;
  "x-sensitive"?: boolean;
}

interface Operation {
  operationId?: string;
  requestBody?: {
    content?: { "application/json"?: { schema?: Schema } };
  };
  responses?: Record<string, { $ref?: string }>;
  security?: Array<Record<string, string[]>>;
  "x-deadline-ms"?: number;
}

interface OpenApiDocument {
  security?: Array<Record<string, string[]>>;
  paths?: Record<string, { get?: Operation; post?: Operation }>;
  components?: {
    schemas?: Record<string, Schema>;
    securitySchemes?: Record<
      string,
      { scheme?: string; type?: string; "x-service-audience"?: string }
    >;
  };
}

// Operations that came from the former standalone LLM Wiki contract.
const llmWikiOperations = [
  ["/healthz", "get"],
  ["/readyz", "get"],
  ["/v0/document-normalizations", "post"],
  ["/internal/v1/wiki-refreshes/{wikiRefreshId}/candidates", "post"],
] as const;

async function readContract(): Promise<OpenApiDocument> {
  return parse(
    await readFile(
      resolve(
        import.meta.dirname,
        "../openapi/node-services-internal/openapi.yaml",
      ),
      "utf8",
    ),
  ) as OpenApiDocument;
}

describe("LLM Wiki internal contract", () => {
  it("exposes no legacy Actor Wiki generation authority", async () => {
    const api = await readContract();
    const paths = api.paths ?? {};
    const schemas = api.components?.schemas ?? {};

    expect(paths).not.toHaveProperty("/actors/{actorId}/wiki/initialize");
    expect(paths).not.toHaveProperty("/actors/{actorId}/wiki/update");
    for (const schema of [
      "WikiGenerationDispatch",
      "WikiInitializedResult",
      "WikiUpdatedResult",
      "WikiInitializeResult",
      "WikiUpdateResult",
      "WikiGenerationErrorResponse",
    ]) {
      expect(schemas).not.toHaveProperty(schema);
    }
  });

  it("generates candidates from exact frozen Document Version inputs without accepting settlement authority", async () => {
    const api = await readContract();
    const operation =
      api.paths?.["/internal/v1/wiki-refreshes/{wikiRefreshId}/candidates"]
        ?.post;
    // TeamHub bounds the whole generation; no per-call deadline is declared.
    expect(operation).not.toHaveProperty("x-deadline-ms");
    expect(operation).toMatchObject({
      operationId: "generateWikiRefreshCandidates",
      security: [{ llmWikiBearer: [] }],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/WikiRefreshCandidateGenerationRequest",
            },
          },
        },
      },
    });

    const schemas = api.components?.schemas ?? {};
    expect(schemas.WikiRefreshCandidateGenerationRequest?.required).toEqual([
      "wiki_refresh_id",
      "tenant_id",
      "generator_agent_actor_id",
      "mode",
      "base_pages",
      "changes",
    ]);
    expect(
      schemas.WikiRefreshCandidateGenerationRequest?.properties?.base_pages
        ?.items,
    ).toEqual({
      $ref: "#/components/schemas/WikiRefreshBasePage",
    });
    expect(schemas.WikiRefreshSourceChanges?.required).toEqual([
      "added",
      "modified",
      "removed",
    ]);
    expect(schemas.WikiRefreshSourceChanges?.properties?.added?.items).toEqual({
      $ref: "#/components/schemas/WikiRefreshFrozenSource",
    });
    expect(schemas.WikiRefreshFrozenSource?.required).toEqual([
      "document_id",
      "document_version_id",
      "filename",
      "size_bytes",
      "sha256",
      "content",
    ]);
    // A frozen source is always the normalized Markdown of its text version.
    expect(schemas.WikiRefreshFrozenSource?.properties).not.toHaveProperty(
      "media_type",
    );
    expect(schemas.WikiRefreshCandidateGenerationResult?.required).toEqual([
      "wiki_refresh_id",
      "pages",
      "unsettled_sources",
      "deferred_sources",
    ]);
    expect(
      schemas.WikiRefreshCandidateGenerationResult?.properties?.pages?.items,
    ).toEqual({
      $ref: "#/components/schemas/WikiRefreshCandidatePage",
    });
    expect(schemas.WikiRefreshCandidatePage?.required).toEqual([
      "page_key",
      "markdown_content",
      "markdown_sha256",
    ]);
    for (const forbidden of [
      "document_id",
      "base_revision_id",
      "base_persisted_seq",
      "owner_actor_id",
      "binding_kind",
      "wiki_id",
    ]) {
      expect(schemas.WikiRefreshCandidatePage?.properties).not.toHaveProperty(
        forbidden,
      );
    }
  });

  it("exposes only service-authenticated compiler operations", async () => {
    const api = await readContract();
    expect(
      llmWikiOperations.map(([path, method]) => {
        const operation = api.paths?.[path]?.[method];
        return [
          operation?.operationId,
          operation?.security ?? api.security ?? [],
        ];
      }),
    ).toEqual([
      ["getLlmWikiHealth", []],
      ["getLlmWikiReadiness", []],
      ["normalizeDocument", [{ llmWikiBearer: [] }]],
      ["generateWikiRefreshCandidates", [{ llmWikiBearer: [] }]],
    ]);
    expect(api.paths).not.toHaveProperty("/internal/v1/wiki/query");
    expect(api.paths).not.toHaveProperty(
      "/internal/v1/wiki-graph-index/{actorId}",
    );
    expect(api.components?.securitySchemes?.llmWikiBearer).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "opaque service token",
    });
    expect(api.paths?.["/v0/document-normalizations"]?.post?.security).toEqual([
      { llmWikiBearer: [] },
    ]);
  });

  it("classifies a normalization timeout as terminal and requires the filename", async () => {
    const api = await readContract();
    const schemas = api.components?.schemas ?? {};
    expect(
      schemas.DocumentNormalizationTerminalErrorResponse?.properties?.error
        ?.properties?.code?.enum,
    ).toContain("DOCUMENT_NORMALIZATION_TIMEOUT");
    expect(
      schemas.DocumentNormalizationRetryableErrorResponse?.properties?.error
        ?.properties?.code,
    ).toMatchObject({ const: "DOCUMENT_NORMALIZATION_UNAVAILABLE" });
    const parameters = (
      api.paths?.["/v0/document-normalizations"]?.post as {
        parameters?: Array<{ name: string; required?: boolean }>;
      }
    ).parameters;
    expect(
      parameters?.find(({ name }) => name === "X-Source-Filename")?.required,
    ).toBe(true);
  });

  it("declares terminal candidate errors separately from retryable failures", async () => {
    const api = await readContract();
    const operation =
      api.paths?.["/internal/v1/wiki-refreshes/{wikiRefreshId}/candidates"]
        ?.post;
    expect(operation?.responses).toHaveProperty("500");
    expect(operation?.responses).toHaveProperty("503");
    const error =
      api.components?.schemas?.WikiRefreshCandidateErrorResponse?.properties
        ?.error;
    expect(error?.required).toEqual(["code", "disposition", "message"]);
    expect(error?.properties?.disposition?.enum).toEqual([
      "retryable",
      "terminal",
    ]);
  });
});
