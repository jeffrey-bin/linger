import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { actorRef, createTeamHubTestSeed } from "@/test/teamhub-seed";
import { digestBlobSha256 } from "@/features/teamhub/sha256-digest";
import type {
  TeamHubDocument,
  TeamHubDocumentPlacementFolder,
} from "@/features/teamhub/teamhub-types";

type Runtime = ReturnType<typeof createTestTeamHubRuntime>;
const now = "2026-08-26T10:00:00.000Z";
const owner = actorRef(createTeamHubTestSeed().identity.actors[0]!);

/** Read seeds only. Tests must declare every write response separately. */
export function createDocumentTestRuntime() {
  const seed = createTeamHubTestSeed();
  seed.documentTree = { items: [] };
  return createTestTeamHubRuntime(seed);
}

export function documentSeeds(runtime: Runtime) {
  const { seed } = runtime;
  return {
    contents: seed.documentVersionContents,
    documents: seed.documents,
    tree: (seed.documentTree ??= { items: [] }),
    versions: seed.documentVersions,
  };
}

export function showDocument(runtime: Runtime, document: TeamHubDocument) {
  documentSeeds(runtime).documents.set(document.id, document);
  return document;
}

export function seedNativeDocument(
  runtime: Runtime,
  id: string,
  input: { parent_id?: string; representation_format?: string } = {},
) {
  const document: TeamHubDocument = {
    capabilities: {
      comment: true,
      delete: true,
      duplicate: true,
      export: true,
      manage: true,
      read: true,
      use_as_context: true,
      write: true,
    },
    created_at: now,
    creator: owner,
    current_version: null,
    can_edit_native_content: true,
    draft_capability: "write",
    format: "blocknote",
    representation_format: input.representation_format ?? "markdown",
    from: [],
    id: `document-${id}`,
    owner,
    status: "active",
    tenant_id: "tenant-northstar",
    title: "untitled",
    updated_at: now,
  };
  if (input.representation_format === "html") {
    Object.assign(document, {
      can_edit_native_content: false,
      draft_capability: "none",
      format: "html",
      title: "untitled.html",
    });
  }
  showDocument(runtime, document);
  seedPlacement(runtime, document, input.parent_id);
  return document;
}

export function seedRoomDocument(
  runtime: Runtime,
  id: string,
  roomId = "room-all",
) {
  const document = seedNativeDocument(runtime, id);
  document.title = "Untitled";
  document.from = [{ binding_kind: "room", context_id: roomId }];
  documentSeeds(runtime).tree.items.pop();
  return document;
}

export function seedFolder(
  runtime: Runtime,
  id: string,
  input: { name: string; parent_id?: string },
): TeamHubDocumentPlacementFolder {
  const folder: TeamHubDocumentPlacementFolder = {
    created_at: now,
    id,
    name: input.name,
    node_kind: "folder",
    parent_id: input.parent_id,
    sort_key: String(documentSeeds(runtime).tree.items.length).padStart(5, "0"),
    updated_at: now,
  };
  documentSeeds(runtime).tree.items.push(folder);
  return folder;
}

export async function seedUploadedDocument(
  runtime: Runtime,
  id: string,
  input: { file: File; representationFormat: string; parentId?: string },
) {
  const document = await seedRoomUpload(runtime, id, input, "");
  document.from = [];
  if (input.representationFormat === "markdown") {
    document.can_edit_native_content = true;
    document.draft_capability = "write";
    document.format = "blocknote";
  }
  return document;
}

export async function seedRoomUpload(
  runtime: Runtime,
  id: string,
  input: { file: File; representationFormat: string; parentId?: string },
  roomId = "room-all",
) {
  const document = seedNativeDocument(runtime, id, {
    parent_id: input.parentId,
  });
  const version = {
    created_at: now,
    created_by: owner,
    document_id: document.id,
    filename: input.file.name,
    id: `version-${id}`,
    media_type: input.file.type || "application/octet-stream",
    representation_format: input.representationFormat,
    sha256: await digestBlobSha256(input.file),
    size_bytes: input.file.size,
    source: "ordinary_upload" as const,
    version_number: 1,
  };
  Object.assign(document, {
    current_version: {
      id: version.id,
      sha256: version.sha256,
      version_number: 1,
    },
    can_edit_native_content: false,
    draft_capability: "none",
    format: input.representationFormat,
    representation_format: input.representationFormat,
    title: input.file.name,
    from: roomId ? [{ binding_kind: "room", context_id: roomId }] : [],
  });
  documentSeeds(runtime).versions.set(version.id, version);
  documentSeeds(runtime).contents.set(
    version.id,
    input.file.slice(0, input.file.size, version.media_type),
  );
  return document;
}

function seedPlacement(
  runtime: Runtime,
  document: TeamHubDocument,
  parentId?: string,
) {
  documentSeeds(runtime).tree.items.push({
    created_at: now,
    document,
    document_id: document.id,
    id: `placement-${document.id}`,
    node_kind: "document",
    parent_id: parentId,
    sort_key: document.id,
    updated_at: now,
  });
}

/** A single declared server result and, optionally, the next read snapshot. */
export function respond<T>(
  mock: { mockImplementationOnce(implementation: () => Promise<T>): unknown },
  response: T,
  nextRead?: () => void,
) {
  mock.mockImplementationOnce(async () => {
    nextRead?.();
    return response;
  });
}
