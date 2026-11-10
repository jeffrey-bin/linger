import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Schema {
  additionalProperties?: boolean;
  allOf?: unknown[];
  const?: unknown;
  description?: string;
  dependentRequired?: Record<string, string[]>;
  discriminator?: { mapping?: Record<string, string>; propertyName?: string };
  enum?: unknown[];
  format?: string;
  oneOf?: Array<{ $ref?: string }>;
  properties?: Record<string, unknown>;
  required?: string[];
  type?: string;
}

interface ComponentDocument {
  components?: { schemas?: Record<string, Schema> };
}

interface OpenApiDocument {
  components?: { schemas?: Record<string, { $ref?: string }> };
  paths?: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        responses?: Record<string, unknown>;
      }
    >
  >;
}

const openApiRoot = resolve(import.meta.dirname, "../openapi");

async function readYaml<T>(path: string): Promise<T> {
  return parse(await readFile(resolve(openApiRoot, path), "utf8")) as T;
}

describe("Unified Document Service public contract", () => {
  it("expands Document with a mixed-version-safe Access V2 envelope", async () => {
    const documents = await readYaml<ComponentDocument>(
      "components/room-documents.yaml",
    );
    const schemas = documents.components?.schemas ?? {};
    const document = schemas.Document;
    const legacyRequired = [
      "id",
      "tenant_id",
      "title",
      "format",
      "representation_format",
      "owner",
      "creator",
      "status",
      "current_version",
      "draft_capability",
      "can_edit_native_content",
      "from",
      "capabilities",
      "created_at",
      "updated_at",
    ];

    expect(document?.required).toEqual(legacyRequired);
    expect(document?.properties?.access_v2).toMatchObject({
      $ref: "#/components/schemas/DocumentAccessEnvelopeV2",
    });
    expect(document?.required).not.toContain("access_v2");

    expect(schemas.DocumentContentRoleV2?.enum).toEqual([
      "viewer",
      "editor",
      "manager",
      "owner",
    ]);
    expect(schemas.DocumentAccessSourceKindV2?.enum).toEqual([
      "owner",
      "direct",
      "context",
      "link",
    ]);
    expect(schemas).not.toHaveProperty("DocumentCollaboratorAdminPolicyV2");
    expect(schemas.DocumentLinkScopeV2?.enum).toEqual([
      "restricted",
      "tenant_members",
      "anyone_with_link",
    ]);
    expect(schemas.DocumentAuthorizationModeV2?.enum).toEqual([
      "human_native",
      "agent_native",
    ]);
    expect(
      schemas.DocumentAccessSourceProvenanceV2?.properties.kind.enum,
    ).toEqual(["owner", "direct_grant", "context_binding", "link_policy"]);

    for (const name of [
      "DocumentAccessEnvelopeV2",
      "DocumentAccessSourceV2",
      "DocumentAccessSourceProvenanceV2",
      "DocumentAccessPolicyV2",
    ]) {
      expect(schemas[name]?.properties).toHaveProperty("schema_version", {
        type: "integer",
        const: 2,
      });
      expect(schemas[name]?.required).toContain("schema_version");
    }

    expect(schemas.DocumentAccessEnvelopeV2?.required).toEqual([
      "schema_version",
      "content_role",
      "sources",
      "policy",
      "authorization_mode",
    ]);
    expect(schemas.DocumentAccessEnvelopeV2?.properties).not.toHaveProperty(
      "capabilities",
    );
    expect(schemas.DocumentDirectCollaboratorCreateRequest?.required).toEqual([
      "target_actor_id",
      "role",
    ]);
    expect(
      schemas.DocumentDirectCollaboratorCreateRequest?.properties?.role,
    ).toMatchObject({ enum: ["viewer", "editor", "manager"] });
    expect(
      schemas.DocumentDirectCollaboratorCreateRequest?.properties,
    ).not.toHaveProperty("owner");
    expect(schemas.DocumentDirectCollaboratorUpdateRequest?.required).toEqual([
      "expected_version",
      "role",
    ]);
    expect(schemas.DocumentDirectCollaboratorRevokeRequest?.required).toEqual([
      "expected_version",
    ]);
    expect(schemas.DocumentShareViewV2?.required).toEqual([
      "schema_version",
      "caller_content_role",
      "can_manage_collaborators",
      "sources",
    ]);
    expect(schemas.DocumentShareViewV2?.properties).toMatchObject({
      management_capabilities: expect.any(Object),
      general_access: expect.any(Object),
    });
    expect(schemas.DocumentShareViewV2?.required).not.toContain(
      "general_access",
    );
    expect(schemas.DocumentGeneralAccessV1?.required).toEqual([
      "scope",
      "canonical_url",
    ]);
    expect(schemas.DocumentShareSourceV2?.properties).toMatchObject({
      source_group: expect.objectContaining({
        enum: ["direct", "context", "link"],
      }),
      caller_access_state: expect.objectContaining({
        enum: ["winning", "remaining", "inactive", "not_caller"],
      }),
    });
    expect(schemas.DocumentTreeSummary?.properties).toHaveProperty(
      "access_sources",
    );
    expect(schemas.DocumentTreeSummary?.required).not.toContain(
      "access_sources",
    );
    expect(schemas).not.toHaveProperty(
      "DocumentCollaboratorPolicyUpdateRequest",
    );
    expect(schemas.DocumentManagementCapabilitiesV2?.required).toEqual([
      "can_change_ownership",
      "can_update_link_policy",
      "can_update_external_policy",
    ]);
    for (const name of [
      "DocumentAccessRequestV2",
      "DocumentAccessRequestCreateRequest",
      "DocumentAccessRequestDecisionRequest",
      "DocumentDelegationV2",
      "DocumentAgentDelegationV1",
    ]) {
      expect(schemas).not.toHaveProperty(name);
    }
  });

  it("supports explicit whole-Document Version comments without a fake BlockNote anchor", async () => {
    const comments = await readYaml<ComponentDocument>(
      "components/room-document-comments.yaml",
    );
    const schemas = comments.components?.schemas ?? {};

    expect(schemas.DocumentCommentThreadCreateRequest?.required).toEqual([
      "initial_comment",
    ]);
    expect(
      schemas.DocumentCommentThreadCreateRequest?.properties,
    ).toHaveProperty("document_version_id");
    expect(schemas.DocumentCommentThreadCreateRequest?.oneOf).toHaveLength(2);
    expect(schemas.DocumentCommentAnchor?.required).toContain("kind");
    expect(schemas.DocumentCommentAnchor?.properties).toHaveProperty(
      "document_version_id",
    );
  });

  it("separates read-only native sessions from comment anchor attachment commands", async () => {
    const api = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    const commentPaths = await readYaml<
      Record<string, { post?: { operationId?: string } }>
    >("paths/teamhub-public-document-comments.yaml");
    expect(
      api.paths?.["/v0/documents/{documentId}/read-session-credentials"]?.post
        ?.operationId,
    ).toBe("createDocumentReadSessionCredential");
    expect(
      commentPaths.documentCommentAnchorAttachments?.post?.operationId,
    ).toBe("attachDocumentCommentSelectionAnchor");
  });

  it("uses only unified Document identities in message and Room event wires", async () => {
    const common = await readYaml<ComponentDocument>("components/common.yaml");
    const messages = await readYaml<ComponentDocument>(
      "components/messages.yaml",
    );
    const messageCards = await readYaml<ComponentDocument>(
      "components/message-cards.yaml",
    );
    const roomEvents = await readYaml<ComponentDocument>(
      "components/room-events.yaml",
    );

    const commonSchemas = common.components?.schemas ?? {};
    const messageSchemas = messages.components?.schemas ?? {};
    const cardSchemas = messageCards.components?.schemas ?? {};
    const eventSchemas = roomEvents.components?.schemas ?? {};

    expect(commonSchemas.FileSegment?.required).toEqual([
      "type",
      "content",
      "document_id",
      "document_version_id",
    ]);
    expect(messageSchemas.MessageAttachment?.required).toEqual([
      "id",
      "document_id",
      "document_version_id",
      "filename",
      "media_type",
      "size_bytes",
      "sha256",
      "available",
    ]);
    expect(messageSchemas.MessageAttachment?.properties).not.toHaveProperty(
      "artifact_id",
    );
    expect(messageSchemas.MessageAttachment?.properties).not.toHaveProperty(
      "artifact_version_id",
    );
    expect(messageSchemas.Message?.required).not.toContain("output_documents");
    expect(messageSchemas.Message?.required).not.toContain("output_artifacts");
    expect(messageSchemas).not.toHaveProperty("MessageDocumentOutput");
    expect(messageSchemas).not.toHaveProperty("MessageArtifactOutput");
    expect(messageSchemas.MessageCreateRequest?.properties).toHaveProperty(
      "context_document_version_ids",
    );
    expect(messageSchemas.MessageCreateRequest?.properties).not.toHaveProperty(
      "context_artifact_version_ids",
    );
    expect(JSON.stringify(cardSchemas)).not.toContain("artifact_version_ids");

    expect(eventSchemas.RoomEventType?.enum).toContain("document.created");
    expect(eventSchemas.RoomEventType?.enum).not.toContain("document.trashed");
    expect(eventSchemas.RoomEventType?.enum ?? []).not.toEqual(
      expect.arrayContaining([
        "artifact.node.created",
        "artifact.node.updated",
        "artifact.version_published",
        "artifact.node.deleted",
      ]),
    );
    expect(eventSchemas).toHaveProperty("RoomDocumentChangedPayload");
    expect(eventSchemas).not.toHaveProperty("ArtifactSnapshotPayload");
  });

  it("does not expose the superseded mandatory Document Proposal protocol", async () => {
    const documents = await Promise.all([
      readYaml<OpenApiDocument>("teamhub-public/teamhub-api.openapi.yaml"),
      readYaml<OpenApiDocument>("teamhub-internal/openapi.yaml"),
      readYaml<OpenApiDocument>("teamhub-agent-api/openapi.yaml"),
      readYaml<OpenApiDocument>("node-services-internal/openapi.yaml"),
    ]);

    for (const document of documents) {
      const paths = Object.keys(document.paths ?? {});
      expect(paths).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("document-edit-proposals"),
        ]),
      );
      expect(paths).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("document-proposal-applications"),
        ]),
      );
      expect(paths).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("document-proposals/validate"),
        ]),
      );
    }

    for (const path of [
      "components/document-internal.yaml",
      "components/document-runtime.yaml",
    ]) {
      const component = await readYaml<ComponentDocument>(path);
      expect(JSON.stringify(component.components?.schemas ?? {})).not.toMatch(
        /Document(?:Edit)?Proposal|ProposalApplication|ProposalValidation/,
      );
    }

    for (const path of [
      "components/room-document-proposals.yaml",
      "paths/teamhub-agent-document-proposals.yaml",
      "paths/teamhub-public-document-proposals.yaml",
    ]) {
      await expect(access(resolve(openApiRoot, path))).rejects.toThrow();
    }
  });

  it("does not expose legacy Artifact identity endpoints after Document cutover", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    const callback = await readYaml<OpenApiDocument>(
      "teamhub-internal/openapi.yaml",
    );

    for (const path of [
      "/v0/rooms/{roomId}/artifact-tree",
      "/v0/rooms/{roomId}/artifact-directories",
      "/v0/rooms/{roomId}/artifacts",
      "/v0/artifact-nodes/{nodeId}",
      "/v0/artifacts/{artifactId}/versions",
      "/v0/artifact-versions/{artifactVersionId}/duplicates",
      "/v0/artifact-versions/{artifactVersionId}/preview-sessions",
      "/v0/artifact-preview-sessions/{artifactPreviewSessionId}",
      "/v0/artifact-versions/{artifactVersionId}",
      "/v0/artifact-versions/{artifactVersionId}/content",
      "/v0/artifact-versions/{artifactVersionId}/document",
    ]) {
      expect(publicApi.paths).not.toHaveProperty(path);
    }
    for (const path of [
      "/v0/rooms/{roomId}/agents/{agentId}/artifacts",
      "/v0/rooms/{roomId}/agents/{agentId}/artifacts/{artifactId}/versions",
    ]) {
      expect(callback.paths).not.toHaveProperty(path);
    }
  });

  it("does not expose retired Workflow Recording APIs", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    for (const path of [
      "/v0/tenants/{tenantId}/workflow-recordings",
      "/v0/workflow-recordings/{workflowRecordingId}",
      "/v0/workflow-recordings/{workflowRecordingId}/chunks/{seq}",
      "/v0/workflow-recordings/{workflowRecordingId}/finalize",
      "/v0/workflow-recordings/{workflowRecordingId}/content",
    ]) {
      expect(publicApi.paths).not.toHaveProperty(path);
    }
  });

  it("creates signed folder previews through Document Version identity only", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    const documents = await readYaml<ComponentDocument>(
      "components/room-documents.yaml",
    );

    expect(
      publicApi.paths?.[
        "/v0/document-versions/{documentVersionId}/preview-sessions"
      ]?.post,
    ).toMatchObject({
      operationId: "createDocumentPreviewSession",
      responses: {
        "201": {
          content: {
            "application/json": {
              schema: {
                $ref: "../components/room-documents.yaml#/components/schemas/DocumentPreviewSession",
              },
            },
          },
        },
      },
    });
    expect(publicApi.paths).not.toHaveProperty(
      "/v0/document-preview-sessions/{documentPreviewSessionId}",
    );
    expect(documents.components?.schemas?.DocumentPreviewSession).toMatchObject(
      {
        type: "object",
        additionalProperties: false,
        required: ["preview_url", "expires_at"],
        properties: {
          preview_url: {
            type: "string",
            format: "uri",
            description: expect.stringContaining("/v0/document-previews/"),
          },
        },
      },
    );
    await expect(
      access(resolve(openApiRoot, "components/artifacts.yaml")),
    ).rejects.toThrow();
  });

  it("keeps TeamHub Run outside canonical Document input authority", async () => {
    const callback = await readYaml<OpenApiDocument>(
      "teamhub-internal/openapi.yaml",
    );
    const runComponents = await readYaml<ComponentDocument>(
      "components/agent-runs.yaml",
    );
    const schemas = runComponents.components?.schemas ?? {};

    expect(callback.paths).not.toHaveProperty(
      "/v0/agent-runs/{runId}/document-revision-inputs/{documentInputId}/content",
    );
    expect(callback.paths).not.toHaveProperty(
      "/v0/agent-runs/{runId}/document-revision-inputs/{documentInputId}/assets/{documentAssetId}/content",
    );
    expect(callback.paths).not.toHaveProperty("/v0/agent-runs/{runId}/open");
    expect(schemas).not.toHaveProperty("OpenRunResponse");
    expect(schemas).not.toHaveProperty("DocumentRevisionInput");
    expect(schemas).not.toHaveProperty("RunDocumentAssetManifestEntry");
  });

  it("keeps Local Runner input free of Room Artifacts", async () => {
    const runnerSchema = await readFile(
      resolve(openApiRoot, "../runner-gateway/envelope.schema.json"),
      "utf8",
    );

    expect(runnerSchema).not.toMatch(
      /artifact_id|artifact_version_id|LocalArtifact|RoomArtifact|LocalWorkspacePlan/u,
    );
  });

  it("does not expose legacy Run Artifact read or publication authority", async () => {
    const callback = await readYaml<OpenApiDocument>(
      "teamhub-internal/openapi.yaml",
    );
    const runComponents = await readYaml<ComponentDocument>(
      "components/agent-runs.yaml",
    );
    const schemas = runComponents.components?.schemas ?? {};

    for (const path of [
      "/v0/agent-runs/{runId}/artifacts/{artifactVersionId}/content",
      "/v0/agent-runs/{runId}/artifacts/{artifactVersionId}/reads",
      "/v0/agent-runs/{runId}/outputs",
      "/v0/agent-runs/{runId}/transfer-capabilities",
      "/v0/agent-run-transfers/{transferToken}",
    ]) {
      expect(callback.paths).not.toHaveProperty(path);
    }

    expect(callback.paths).not.toHaveProperty(
      "/v0/agents/{agentId}/invocations",
    );
    for (const schema of [
      "RequestAgentInvocationRequest",
      "RequestAgentInvocationResponse",
      "AgentRunAdmitted",
      "AgentInvocationRejected",
    ]) {
      expect(schemas).not.toHaveProperty(schema);
    }
    expect(schemas).not.toHaveProperty("RunCompletedEventPayload");
    for (const schema of [
      "RunInputArtifact",
      "UpdateExistingPublication",
      "CreateNewPublication",
      "ArtifactPublicationIntent",
      "StageRunOutputMetadata",
      "StageRunOutputRequest",
      "StagedRunOutput",
      "RunArtifactDownloadTransferRequest",
    ]) {
      expect(schemas).not.toHaveProperty(schema);
    }
  });

  it("uses unified Document identities for the internal Personal Wiki query snapshot", async () => {
    const callback = await readYaml<OpenApiDocument>(
      "teamhub-internal/openapi.yaml",
    );
    const worker = await readYaml<ComponentDocument>(
      "components/personal-wiki-worker.yaml",
    );

    expect(callback.paths).not.toHaveProperty(
      "/v0/personal-wiki-generations/{generationId}/revision",
    );
    expect(callback.paths).not.toHaveProperty(
      "/v0/personal-wiki-generations/{generationId}/failure",
    );
    expect(callback.paths).not.toHaveProperty(
      "/v0/personal-wikis/{actorId}/revision",
    );
    expect(callback.paths).not.toHaveProperty(
      "/v0/personal-wikis/{actorId}/revisions/{revisionId}/files/{outputFileId}/content",
    );
    expect(
      callback.paths?.["/v0/personal-wikis/{actorId}/document-revision"]?.get
        ?.operationId,
    ).toBe("getPersonalWikiDocumentRevision");
    expect(
      callback.paths?.[
        "/v0/personal-wikis/{actorId}/document-revisions/{wikiRevisionId}/documents/{documentId}/versions/{documentVersionId}/content"
      ]?.get?.operationId,
    ).toBe("downloadPersonalWikiDocumentVersion");

    const schemas = worker.components?.schemas ?? {};
    expect(schemas.PersonalWikiDocumentRevision?.required).toEqual([
      "wiki_revision_id",
      "published_at",
      "pages",
    ]);
    expect(schemas.PersonalWikiDocumentPage?.required).toEqual([
      "page_key",
      "document_id",
      "document_version_id",
      "media_type",
      "size_bytes",
      "sha256",
    ]);
    expect(schemas).not.toHaveProperty("PersonalWikiPublishedFile");
    expect(schemas).not.toHaveProperty("PersonalWikiRevisionPublishRequest");
    expect(schemas).not.toHaveProperty("PersonalWikiGenerationFailureRequest");
  });

  it("defines the stable aggregate, version, revision input, and generation pin models", async () => {
    const document = await readYaml<ComponentDocument>(
      "components/room-documents.yaml",
    );
    const schemas = document.components?.schemas ?? {};

    expect(schemas.Document?.required).toEqual(
      expect.arrayContaining([
        "id",
        "tenant_id",
        "title",
        "format",
        "owner",
        "creator",
        "status",
        "current_version",
        "draft_capability",
        "from",
        "capabilities",
        "created_at",
        "updated_at",
      ]),
    );
    expect(schemas.UnifiedDocumentFrom?.properties?.page_key).toMatchObject({
      type: "string",
      pattern: "^[a-z0-9][a-z0-9._/-]*\\.md$",
    });
    expect(schemas.UnifiedDocumentFrom?.required).not.toContain("page_key");
    expect(schemas.DocumentVersion?.required).toEqual(
      expect.arrayContaining([
        "id",
        "document_id",
        "version_number",
        "filename",
        "representation_format",
        "media_type",
        "size_bytes",
        "sha256",
        "created_by",
        "source",
        "created_at",
      ]),
    );
    expect(schemas.DocumentVersion?.dependentRequired).toEqual({
      source_revision_id: ["exporter_schema_version"],
    });
    expect(schemas.DocumentRevisionInput?.required).toEqual(
      expect.arrayContaining([
        "revision_id",
        "persisted_seq",
        "state_vector",
        "full_state_fingerprint",
        "asset_manifest",
        "input_schema_version",
        "content_object_id",
        "size_bytes",
        "sha256",
        "object_status",
      ]),
    );
    expect(schemas.DocumentHistoryEntry?.required).toEqual(
      expect.arrayContaining([
        "id",
        "document_id",
        "revision_id",
        "persisted_seq",
        "created_by",
        "contributors",
        "trigger",
        "created_at",
      ]),
    );
    expect(schemas.DocumentHistoryCheckpoint?.required).toEqual(
      expect.arrayContaining([
        "id",
        "document_id",
        "target_persisted_seq",
        "status",
      ]),
    );
    expect(schemas.DocumentHistoryRestoreResult?.required).toEqual([
      "status",
      "history_entry",
    ]);
    expect(schemas.DocumentHistoryContent?.required).toEqual([
      "history_entry",
      "state_bytes",
      "state_bytes_sha256",
      "state_vector",
      "full_state_fingerprint",
      "asset_manifest",
    ]);
    expect(schemas).not.toHaveProperty("DocumentLifecycleOperation");
    expect(schemas.DocumentUploadRequest?.required).toEqual([
      "filename",
      "representation_format",
      "content",
    ]);
    expect(schemas.DocumentUploadRequest?.properties?.content).toEqual({
      format: "binary",
      type: "string",
    });
    expect(schemas.DocumentVersionUploadRequest?.required).toEqual([
      "expected_current_version_id",
      "filename",
      "representation_format",
      "content",
    ]);
    expect(schemas.DocumentVersionUploadRequest?.properties?.content).toEqual({
      format: "binary",
      type: "string",
    });
    expect(schemas.DocumentMetadataUpdateRequest?.required).toEqual(["title"]);
    expect(schemas.DocumentDraftTitleUpdateRequest?.required).toEqual([
      "title",
    ]);
  });

  it("exports the models to generated consumers without exposing Human Publish", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    expect(publicApi.components?.schemas?.Document?.$ref).toBe(
      "../components/room-documents.yaml#/components/schemas/Document",
    );
    expect(publicApi.components?.schemas?.DocumentVersion?.$ref).toBe(
      "../components/room-documents.yaml#/components/schemas/DocumentVersion",
    );

    const operationIds = Object.values(publicApi.paths ?? {}).flatMap((path) =>
      Object.values(path).flatMap((operation) => operation.operationId ?? []),
    );
    expect(operationIds).toEqual(
      expect.arrayContaining([
        "getDocument",
        "createTenantDocument",
        "uploadTenantDocument",
        "uploadRoomDocument",
        "uploadWorkItemDocument",
        "uploadPersonalWikiDocument",
        "uploadDocumentVersion",
        "updateDocumentMetadata",
        "updateDocumentDraftTitle",
        "listLibraryDocuments",
        "searchLibraryDocuments",
        "listDocumentVersions",
        "getDocumentVersion",
        "headDocumentVersionContent",
        "downloadDocumentVersion",
        "getTenantMyDocumentTree",
        "createTenantMyDocumentFolder",
        "updateTenantMyDocumentPlacement",
        "deleteTenantMyDocumentFolder",
        "listDocumentHistory",
        "getDocumentHistoryContent",
        "createDocumentHistoryCheckpoint",
        "restoreDocumentHistoryEntry",
        "trashDocument",
        "restoreDocument",
        "downloadLatestDocument",
        "getDocumentShareView",
        "createDocumentDirectCollaborator",
        "updateDocumentDirectCollaborator",
        "revokeDocumentDirectCollaborator",
      ]),
    );
    for (const removed of [
      "updateDocumentCollaboratorPolicy",
      "createDocumentAccessRequest",
      "decideDocumentAccessRequest",
      "createDocumentAgentDelegation",
      "updateDocumentAgentDelegation",
      "revokeDocumentAgentDelegation",
    ]) {
      expect(operationIds).not.toContain(removed);
    }
    expect(operationIds).not.toContain("getRoomDocument");
    expect(operationIds).not.toContain("exportDocumentRevision");
    expect(operationIds).not.toContain("exportDocumentRevisionArtifact");
    expect(publicApi.components?.schemas).not.toHaveProperty(
      "DocumentExportArtifact",
    );
    expect(operationIds).not.toContain("setDocumentFavorite");
    expect(operationIds).not.toContain("clearDocumentFavorite");
    for (const deferredSharingOperation of [
      "grantDocumentMentionAccess",
      "shareDocumentToRoom",
      "pasteDocumentIntoRoom",
      "createDocumentLinkAudience",
    ]) {
      expect(operationIds).not.toContain(deferredSharingOperation);
    }
    for (const forbiddenOperation of [
      "publishDocument",
      "publishDocumentRevision",
      "requestRoomDocumentPublication",
      "getRoomDocumentPublication",
      "getRoomDocumentPublicationConflict",
      "downloadRoomDocumentPublicationConflictCandidate",
    ]) {
      expect(operationIds).not.toContain(forbiddenOperation);
    }
    for (const forbiddenPath of [
      "/v0/documents/{documentId}/publications",
      "/v0/document-publications/{documentPublicationId}",
      "/v0/document-publications/{documentPublicationId}/conflict",
      "/v0/document-publications/{documentPublicationId}/conflict/candidate/content",
    ]) {
      expect(publicApi.paths).not.toHaveProperty(forbiddenPath);
    }
  });

  it("uses typed Human upload routes without client-selected Binding coordinates", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    for (const [path, operationId] of [
      ["/v0/rooms/{roomId}/documents/uploads", "uploadRoomDocument"],
      [
        "/v0/work-items/{workItemId}/documents/uploads",
        "uploadWorkItemDocument",
      ],
      [
        "/v0/tenants/{tenantId}/personal-wiki/documents/uploads",
        "uploadPersonalWikiDocument",
      ],
    ]) {
      expect(publicApi.paths?.[path]?.post).toMatchObject({ operationId });
    }
    const document = await readYaml<ComponentDocument>(
      "components/room-documents.yaml",
    );
    expect(
      document.components?.schemas?.ContextDocumentUploadRequest,
    ).toMatchObject({
      required: ["filename", "representation_format", "content"],
      properties: {
        filename: { type: "string", minLength: 1, maxLength: 255 },
        representation_format: {
          type: "string",
          minLength: 1,
          maxLength: 120,
        },
        content: { type: "string", format: "binary" },
      },
    });
    for (const forbidden of [
      "parent_id",
      "binding_kind",
      "room_id",
      "work_item_id",
      "wiki_id",
      "owner_actor_id",
      "beneficiary_human_actor_id",
    ]) {
      expect(
        document.components?.schemas?.ContextDocumentUploadRequest?.properties,
      ).not.toHaveProperty(forbidden);
    }
  });

  it("creates native Room Documents through the unified aggregate only", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    expect(
      publicApi.paths?.["/v0/rooms/{roomId}/documents"]?.post,
    ).toMatchObject({
      operationId: "createRoomDocument",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              $ref: "../components/room-documents.yaml#/components/schemas/ContextDocumentCreateRequest",
            },
          },
        },
      },
      responses: {
        "201": {
          content: {
            "application/json": {
              schema: {
                $ref: "../components/room-documents.yaml#/components/schemas/Document",
              },
            },
          },
        },
      },
    });
    const document = await readYaml<ComponentDocument>(
      "components/room-documents.yaml",
    );
    expect(document.components?.schemas?.ContextDocumentCreateRequest).toEqual({
      additionalProperties: false,
      type: "object",
    });
  });

  it("uses stable Document identity for Room message references and candidates", async () => {
    const common = await readYaml<ComponentDocument>("components/common.yaml");
    const schemas = common.components?.schemas ?? {};
    expect(schemas.DocumentSegment).toMatchObject({
      additionalProperties: false,
      required: ["type", "content", "document_id"],
      properties: {
        type: { type: "string", const: "document" },
        content: { type: "string", minLength: 1, maxLength: 50000 },
        document_id: { $ref: "#/components/schemas/Id" },
      },
    });
    expect(schemas.MessageSegment?.oneOf).toContainEqual({
      $ref: "#/components/schemas/DocumentSegment",
    });
    expect(schemas.MessageSegment?.discriminator?.mapping).toMatchObject({
      document: "#/components/schemas/DocumentSegment",
    });

    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    expect(
      publicApi.paths?.["/v0/rooms/{roomId}/documents"]?.get,
    ).toMatchObject({ operationId: "listRoomDocuments" });
  });

  it("duplicates server-resolved content into one selected My Documents folder", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    const document = await readYaml<ComponentDocument>(
      "components/room-documents.yaml",
    );
    expect(
      publicApi.paths?.["/v0/documents/{documentId}/duplicates"]?.post,
    ).toMatchObject({
      operationId: "duplicateDocument",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "../components/room-documents.yaml#/components/schemas/DocumentDuplicateRequest",
            },
          },
        },
      },
      responses: {
        "201": {
          content: {
            "application/json": {
              schema: {
                $ref: "../components/room-documents.yaml#/components/schemas/Document",
              },
            },
          },
        },
      },
    });
    expect(document.components?.schemas?.DocumentDuplicateRequest).toEqual({
      additionalProperties: false,
      properties: {
        target_folder_id: {
          $ref: "./common.yaml#/components/schemas/Id",
        },
      },
      type: "object",
    });
    expect(publicApi.paths?.["/v0/documents/{documentId}"]).toMatchObject({
      get: { operationId: "getDocument" },
      patch: { operationId: "updateDocumentMetadata" },
      delete: { operationId: "trashDocument" },
    });
    expect(
      publicApi.paths?.["/v0/documents/{documentId}/duplicates"],
    ).not.toHaveProperty("patch");
    expect(
      publicApi.paths?.["/v0/documents/{documentId}/duplicates"],
    ).not.toHaveProperty("delete");
  });

  it("removes Favorite from the active public Document surface", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    const view = publicApi.paths?.[
      "/v0/library/documents"
    ]?.get?.parameters?.find((parameter) => parameter.name === "view");
    expect(view?.schema?.enum).toEqual([
      "recent",
      "owned",
      "shared",
      "unfiled",
      "shareable",
    ]);
    expect(publicApi.paths).not.toHaveProperty(
      "/v0/documents/{documentId}/favorite",
    );
  });

  it("binds an owned Document through Room, Task, and Wiki typed commands only", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    for (const [path, operationId] of [
      ["/v0/rooms/{roomId}/documents/{documentId}", "bindDocumentToRoom"],
      [
        "/v0/work-items/{workItemId}/documents/{documentId}",
        "bindDocumentToWorkItem",
      ],
      [
        "/v0/tenants/{tenantId}/personal-wiki/documents/{documentId}",
        "bindDocumentToPersonalWiki",
      ],
    ]) {
      expect(publicApi.paths?.[path]?.put).toMatchObject({
        operationId,
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  $ref: "../components/room-documents.yaml#/components/schemas/Document",
                },
              },
            },
          },
        },
      });
      expect(publicApi.paths?.[path]?.put).not.toHaveProperty("requestBody");
    }
    expect(publicApi.paths).not.toHaveProperty("/v0/document-bindings");
    expect(publicApi.paths).not.toHaveProperty(
      "/v0/documents/{documentId}/bindings",
    );
  });

  it("lists Personal Wiki sources and pages through unified Document identity", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    expect(
      publicApi.paths?.["/v0/tenants/{tenantId}/personal-wiki/documents"]?.get,
    ).toMatchObject({
      operationId: "listPersonalWikiDocuments",
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                $ref: "../components/room-documents.yaml#/components/schemas/DocumentPage",
              },
            },
          },
        },
      },
    });
  });

  it("exposes the current Human's derived Personal Knowledge Graph visualization", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    expect(
      publicApi.paths?.["/v0/tenants/{tenantId}/personal-wiki/graph"]?.get,
    ).toMatchObject({
      operationId: "getPersonalKnowledgeGraphVisualization",
      responses: {
        "200": {
          content: {
            "text/html": {
              schema: { type: "string" },
            },
          },
        },
      },
    });
  });

  it("does not expose legacy Personal Wiki file or tree identities", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    for (const path of [
      "/v0/tenants/{tenantId}/personal-wiki/input-tree",
      "/v0/tenants/{tenantId}/personal-wiki/input-directories",
      "/v0/tenants/{tenantId}/personal-wiki/input-files",
      "/v0/tenants/{tenantId}/personal-wiki/imports",
      "/v0/tenants/{tenantId}/personal-wiki/output-tree",
      "/v0/personal-wiki/output-files/{personalWikiOutputFileId}",
      "/v0/personal-wiki/output-files/{personalWikiOutputFileId}/content",
      "/v0/personal-wiki/input-nodes/{personalWikiInputNodeId}",
      "/v0/personal-wiki/input-files/{personalWikiInputNodeId}/versions",
      "/v0/personal-wiki/input-versions/{personalWikiInputVersionId}",
      "/v0/personal-wiki/input-versions/{personalWikiInputVersionId}/content",
    ]) {
      expect(publicApi.paths).not.toHaveProperty(path);
    }

    const personalWiki = await readYaml<ComponentDocument>(
      "components/personal-wiki.yaml",
    );
    const schemas = personalWiki.components?.schemas ?? {};
    for (const schema of [
      "PersonalWikiInputNode",
      "PersonalWikiInputTree",
      "PersonalWikiInputVersion",
      "PersonalWikiOutputFile",
      "PersonalWikiOutputTree",
    ]) {
      expect(schemas).not.toHaveProperty(schema);
    }

    const externalSources = await readYaml<ComponentDocument>(
      "components/external-sources.yaml",
    );
    // Personal Wiki import is retired, and with it the Gmail import result.
    expect(externalSources.components?.schemas).not.toHaveProperty(
      "GmailImportResult",
    );
    expect(
      publicApi.paths?.["/v0/tenants/{tenantId}/personal-wiki"]?.delete,
    ).toBeUndefined();
  });
});

describe("Unified Document Service Runtime apply contract", () => {
  it("applies server changes synchronously without an outbox", async () => {
    const runtimeApi = await readYaml<OpenApiDocument>(
      "node-services-internal/openapi.yaml",
    );
    const operationIds = Object.values(runtimeApi.paths ?? {}).flatMap((path) =>
      Object.values(path).flatMap((operation) => operation.operationId ?? []),
    );
    expect(operationIds).toContain("applyDocumentChange");
    expect(operationIds).not.toContain("deliverCommittedDocumentUpdate");

    const components = await readYaml<ComponentDocument>(
      "components/document-runtime.yaml",
    );
    expect(
      components.components?.schemas?.ApplyDocumentChangeRequest?.required,
    ).toEqual(["operation_id", "actor_id", "change"]);
    expect(
      components.components?.schemas?.AppliedDocumentChangeResult?.required,
    ).toEqual(["status", "seq", "state_hash", "title", "complete_references"]);
  });
});

describe("Unified Document Room Binding and Forward contract", () => {
  it("exposes atomic Forward and explicit Room removal without Recall", async () => {
    const publicApi = await readYaml<OpenApiDocument>(
      "teamhub-public/teamhub-api.openapi.yaml",
    );
    expect(
      publicApi.paths?.["/v0/rooms/{roomId}/messages/{messageId}/forward"]?.post
        ?.operationId,
    ).toBe("forwardRoomMessage");
    expect(
      publicApi.paths?.[
        "/v0/documents/{documentId}/room-bindings/{roomId}/remove"
      ]?.post?.operationId,
    ).toBe("removeDocumentFromRoom");
    expect(publicApi.paths).not.toHaveProperty(
      "/v0/documents/{documentId}/room-message-shares",
    );
    expect(publicApi.paths).not.toHaveProperty(
      "/v0/rooms/{roomId}/messages/{messageId}/recall",
    );

    const documents = await readYaml<ComponentDocument>(
      "components/room-documents.yaml",
    );
    expect(
      documents.components?.schemas?.DocumentRoomBindingRemoveRequest?.required,
    ).toEqual(["expected_version"]);
    expect(
      documents.components?.schemas?.DocumentRoomBindingResultV1?.required,
    ).toEqual([
      "binding_id",
      "document_id",
      "room_id",
      "role",
      "status",
      "version",
    ]);
  });
});
