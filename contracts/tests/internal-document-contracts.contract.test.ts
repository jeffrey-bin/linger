import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface OpenAPIOperation {
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  requestBody?: unknown;
  responses?: Record<string, { $ref?: string }>;
  "x-deadline-ms"?: number;
  "x-idempotency"?: string;
  "x-idempotency-key"?: string;
  "x-max-request-body-bytes"?: number;
  "x-max-response-decoded-bytes"?: number;
}

interface OpenAPIDocument {
  security?: Array<Record<string, string[]>>;
  paths?: Record<string, Record<string, OpenAPIOperation>>;
  components?: {
    securitySchemes?: Record<string, { "x-service-audience"?: string }>;
  };
}

interface SchemaDocument {
  components?: {
    schemas?: Record<
      string,
      {
        const?: string;
        format?: string;
        discriminator?: { propertyName?: string };
        enum?: string[];
        maxLength?: number;
        minLength?: number;
        maxItems?: number;
        oneOf?: Array<{ $ref?: string }>;
        pattern?: string;
        properties?: Record<string, unknown>;
        required?: string[];
        type?: string;
        "x-max-decoded-bytes"?: number;
        "x-max-total-items"?: number;
      }
    >;
  };
}

const contractRoot = resolve(import.meta.dirname, "../openapi");

async function readContract(name: string): Promise<OpenAPIDocument> {
  const source = await readFile(
    resolve(contractRoot, name, "openapi.yaml"),
    "utf8",
  );
  return parse(source) as OpenAPIDocument;
}

async function readTeamHubPublicContract(): Promise<OpenAPIDocument> {
  const source = await readFile(
    resolve(contractRoot, "teamhub-public/teamhub-api.openapi.yaml"),
    "utf8",
  );
  return parse(source) as OpenAPIDocument;
}

// The Document Runtime operations live inside the merged
// node-services-internal contract; TeamHub serves the Runtime nothing.
const documentRuntimePaths = [
  "/internal/v1/documents/import",
  "/internal/v1/documents/export",
  "/internal/v1/documents/{documentId}/apply",
  "/internal/v1/documents/{documentId}/disconnect",
];

// Restricts a merged contract to the exact paths that came from one old
// contract; components stay whole because the merged file shares them.
function selectPaths(
  document: OpenAPIDocument,
  paths: string[],
): OpenAPIDocument {
  return {
    ...document,
    paths: Object.fromEntries(
      Object.entries(document.paths ?? {}).filter(([path]) =>
        paths.includes(path),
      ),
    ),
  };
}

async function readDocumentRuntimeContract(): Promise<OpenAPIDocument> {
  return selectPaths(
    await readContract("node-services-internal"),
    documentRuntimePaths,
  );
}

function operationSecurity(
  document: OpenAPIDocument,
): Array<Array<Record<string, string[]>> | undefined> {
  return Object.values(operationsById(document)).map(
    (operation) => operation.security ?? document.security,
  );
}

function operationIds(document: OpenAPIDocument): string[] {
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  return Object.values(document.paths ?? {})
    .flatMap((path) =>
      Object.entries(path)
        .filter(([method]) => methods.has(method))
        .map(([, operation]) => operation.operationId),
    )
    .filter((operationId): operationId is string => Boolean(operationId))
    .sort();
}

function operationsById(
  document: OpenAPIDocument,
): Record<string, OpenAPIOperation> {
  const operations: Record<string, OpenAPIOperation> = {};
  for (const path of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(path)) {
      if (operation.operationId) {
        operations[operation.operationId] = operation;
      }
    }
  }
  return operations;
}

describe("Room Document internal contracts", () => {
  it("does not expose the retired Room Document publication preparation protocol", async () => {
    const teamHub = await readContract("teamhub-internal");
    const runtime = await readContract("node-services-internal");
    const shared = parse(
      await readFile(
        resolve(contractRoot, "components/document-internal.yaml"),
        "utf8",
      ),
    ) as SchemaDocument;
    const runtimeSchemas = parse(
      await readFile(
        resolve(contractRoot, "components/document-runtime.yaml"),
        "utf8",
      ),
    ) as SchemaDocument;

    expect(operationIds(teamHub)).not.toEqual(
      expect.arrayContaining([
        "getDocumentPublicationPreparation",
        "recordDocumentPublicationGateAbort",
        "stageDocumentPublicationPreparation",
      ]),
    );
    expect(operationIds(runtime)).not.toContain("prepareDocumentPublication");
    for (const schemaName of [
      "AbsentDocumentPublicationPreparation",
      "DocumentPublicationGateAbort",
      "DocumentPublicationPreparation",
      "GetDocumentPublicationPreparationResponse",
      "PreparedDocumentPublicationPreparation",
      "RecordDocumentPublicationGateAbortRequest",
      "StageDocumentPublicationPreparationRequest",
    ]) {
      expect(shared.components?.schemas).not.toHaveProperty(schemaName);
    }
    for (const schemaName of [
      "PrepareDocumentPublicationRequest",
      "PrepareDocumentPublicationResult",
      "PreparedDocumentPublicationResult",
      "RetryableDocumentPublicationResult",
    ]) {
      expect(runtimeSchemas.components?.schemas).not.toHaveProperty(schemaName);
    }
  });

  it("lets the Runtime save bodies itself and authenticates connections once", async () => {
    const shared = parse(
      await readFile(
        resolve(contractRoot, "components/document-internal.yaml"),
        "utf8",
      ),
    ) as SchemaDocument;
    const publicDocument = parse(
      await readFile(
        resolve(contractRoot, "components/room-documents.yaml"),
        "utf8",
      ),
    ) as SchemaDocument;
    const schemas = shared.components?.schemas ?? {};
    const credential =
      publicDocument.components?.schemas?.RoomDocumentCollaborationCredential;

    // The Runtime loads and saves document_bodies itself, so no state load,
    // reference check or append crosses a process boundary.
    for (const schemaName of [
      "AppendDocumentUpdateBatchRequest",
      "DocumentSessionLimits",
      "DocumentStateBundle",
      "OpenDocumentSessionRequest",
      "OpenDocumentSessionResponse",
      "ValidateDocumentReferencesRequest",
      "ValidateDocumentReferencesResponse",
      "AuthorizeDocumentMutationRequest",
      "DocumentWritePermit",
    ]) {
      expect(schemas).not.toHaveProperty(schemaName);
    }
    for (const schemaName of [
      "DurableAckEnvelope",
      "DurabilityFailureEnvelope",
    ]) {
      expect(schemas[schemaName]?.properties).not.toHaveProperty(
        "access_epoch",
      );
      expect(schemas[schemaName]?.properties).not.toHaveProperty("session_id");
      expect(schemas[schemaName]?.properties).not.toHaveProperty("permit_ids");
    }
    expect(credential?.required).toEqual([
      "document_id",
      "collaboration_credential",
      "expires_at",
    ]);
  });

  it("declares validation failure for the public Document Asset upload plan", async () => {
    const teamHubPublic = await readTeamHubPublicContract();
    expect(
      operationsById(teamHubPublic).planRoomDocumentAsset?.responses?.["422"]
        ?.$ref,
    ).toBe("../components/common.yaml#/components/responses/BadRequest");
  });

  it("separates the exact provider operation sets and service audiences", async () => {
    const teamHub = await readContract("teamhub-internal");
    const runtime = await readDocumentRuntimeContract();

    expect(
      Object.keys(teamHub.paths ?? {}).filter((path) =>
        path.startsWith("/internal/v1/document-"),
      ),
    ).toEqual([]);
    // TeamHub applies server changes through the Runtime and keeps no
    // outbox or computation ledger.
    expect(operationIds(runtime)).toEqual(
      [
        "applyDocumentChange",
        "disconnectDocumentConnections",
        "exportDocument",
        "importDocument",
      ].sort(),
    );
    expect(Object.keys(runtime.paths ?? {}).sort()).toEqual(
      [...documentRuntimePaths].sort(),
    );

    expect(teamHub.components?.securitySchemes).not.toHaveProperty(
      "runtimeToTeamHubBearer",
    );
    expect(operationSecurity(runtime)).toEqual(
      documentRuntimePaths.map(() => [{ teamHubToRuntimeBearer: [] }]),
    );
    expect(runtime.components?.securitySchemes?.teamHubToRuntimeBearer).toEqual(
      expect.objectContaining({
        "x-service-audience": "document-runtime",
      }),
    );
  });

  it("fixes typed failures, idempotency, deadlines, payload limits, and durable head scoping", async () => {
    const runtime = await readDocumentRuntimeContract();
    const shared = parse(
      await readFile(
        resolve(contractRoot, "components/document-internal.yaml"),
        "utf8",
      ),
    ) as SchemaDocument;
    const errors = parse(
      await readFile(
        resolve(contractRoot, "components/document-errors.yaml"),
        "utf8",
      ),
    ) as SchemaDocument;
    const runtimeSchemas = parse(
      await readFile(
        resolve(contractRoot, "components/document-runtime.yaml"),
        "utf8",
      ),
    ) as SchemaDocument;
    const operations = operationsById(runtime);

    expect(shared.components?.schemas?.DocumentInternalId).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
    });
    expect(
      shared.components?.schemas?.DocumentInternalId?.format,
    ).toBeUndefined();
    expect(shared.components?.schemas?.DurableAckEnvelope).toMatchObject({
      additionalProperties: false,
      required: ["type", "head"],
      properties: { type: { const: "durability_ack" } },
    });
    expect(shared.components?.schemas?.DurabilityFailureEnvelope).toMatchObject(
      {
        additionalProperties: false,
        required: ["type", "code", "document_id"],
        properties: {
          code: {
            enum: [
              "append_rejected",
              "backlog_exceeded",
              "durability_invariant_failed",
            ],
          },
          type: { const: "durability_failure" },
        },
      },
    );
    expect(runtime.components?.schemas).toEqual(
      expect.objectContaining({
        DurableAckEnvelope: expect.any(Object),
        DurabilityFailureEnvelope: expect.any(Object),
      }),
    );

    const deadlines: Record<string, number> = {
      applyDocumentChange: 30_000,
      disconnectDocumentConnections: 5_000,
      exportDocument: 30_000,
      importDocument: 30_000,
    };
    expect(Object.keys(operations).sort()).toEqual(
      Object.keys(deadlines).sort(),
    );
    for (const [operationId, deadline] of Object.entries(deadlines)) {
      const operation = operations[operationId];
      expect(operation, operationId).toBeDefined();
      expect(operation?.["x-deadline-ms"], operationId).toBe(deadline);
      expect(operation?.responses?.default?.$ref, operationId).toBe(
        "../components/document-errors.yaml#/components/responses/DocumentInternalError",
      );
      if (operation?.requestBody) {
        expect(operation["x-max-request-body-bytes"], operationId).toBe(
          operationId === "disconnectDocumentConnections"
            ? 1024
            : 48 * 1024 * 1024,
        );
      }
    }

    expect(
      runtimeSchemas.components?.schemas?.DocumentChange?.discriminator
        ?.propertyName,
    ).toBe("kind");
    expect(
      runtimeSchemas.components?.schemas?.ConflictedDocumentChangeResult
        ?.properties,
    ).toHaveProperty("reason");

    const schemas = shared.components?.schemas ?? {};
    expect(schemas.YjsMutationFrame?.["x-max-decoded-bytes"]).toBe(
      1 * 1024 * 1024,
    );
    expect(schemas.YjsUpdate?.["x-max-decoded-bytes"]).toBe(4 * 1024 * 1024);
    expect(schemas.CompleteReferences?.["x-max-total-items"]).toBe(4096);
    expect(schemas.ManifestEntries?.maxItems).toBe(4096);
    expect(schemas).not.toHaveProperty("DocumentRuntimeEvent");
    expect(schemas).not.toHaveProperty("RenewDocumentRuntimeLeaseRequest");

    expect(errors.components?.schemas?.InternalErrorCode?.enum).toEqual(
      expect.arrayContaining([
        "deadline_exceeded",
        "idempotency_conflict",
        "payload_too_large",
        "stale_membership",
        "state_bundle_inconsistent",
      ]),
    );
    expect(schemas.DocumentDurableHead?.properties).not.toHaveProperty(
      "access_epoch",
    );

    expect(schemas).not.toHaveProperty("UnstagedDocumentProposalApplication");
    expect(schemas).not.toHaveProperty("StagedDocumentProposalApplication");
    expect(schemas).not.toHaveProperty("CommittedDocumentProposalApplication");
    expect(schemas).not.toHaveProperty("ConflictedDocumentProposalApplication");

    expect(runtimeSchemas.components?.schemas).not.toHaveProperty(
      "ApplyDocumentEditProposalResult",
    );
    expect(runtimeSchemas.components?.schemas).not.toHaveProperty(
      "ApplyDocumentEditProposalRequest",
    );
    expect(schemas).not.toHaveProperty("ProposalApplicationInput");
  });
});
