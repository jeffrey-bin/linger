import {
  ROOM_DOCUMENT_MAX_REFERENCES,
  ROOM_DOCUMENT_MAX_STATE_BYTES,
  type RoomDocumentAssetManifestEntry,
  type RoomDocumentExportFormat,
} from "@linger/document-model";
import type { DocumentRuntimeHandlers } from "@linger/wire-contracts/node-services-internal/server";
import type { components } from "@linger/wire-contracts/node-services-internal/types";

import type { DocumentComputation } from "./computation-pool.js";
import { RuntimeInputError, sha256Pattern } from "./runtime-input.js";

type ExportRequest = components["schemas"]["ExportDocumentRequest"];
type RuntimeContext = Parameters<DocumentRuntimeHandlers["exportDocument"]>[0];

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const formats = new Set<RoomDocumentExportFormat>([
  "markdown",
  "plain_text",
  "html",
  "blocks",
]);

export async function exportDocument(
  context: RuntimeContext,
  computation: DocumentComputation,
): Promise<Response> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return errorResponse(
      context,
      400,
      "invalid_request",
      "Revision export request body must be valid JSON",
    );
  }
  try {
    const request = parseExportRequest(body);
    const result = await computation.run("exportRoomDocumentRevision", {
      revisionId: request.revision_id,
      schemaVersion: request.schema_version,
      state: toModelState(request.state),
      assetManifest: request.asset_manifest.map(toModelManifestEntry),
      format: request.format,
    });
    return context.json({
      media_type: result.mediaType,
      bytes: Buffer.from(result.bytes).toString("base64"),
      size_bytes: result.sizeBytes,
      sha256: result.sha256,
      complete_references: {
        document_asset_ids: result.completeReferences.documentAssetIds,
        document_thread_ids: result.completeReferences.documentThreadIds,
      },
      warnings: result.warnings,
    });
  } catch (error) {
    if (isModelError(error) || error instanceof RuntimeInputError) {
      return errorResponse(
        context,
        error.code === "payload_too_large" ? 413 : 422,
        error.code,
        error.message,
      );
    }
    return errorResponse(
      context,
      500,
      "internal_error",
      "Document Revision export failed",
    );
  }
}

function parseExportRequest(value: unknown): ExportRequest {
  const request = requireRecord(value, [
    "revision_id",
    "schema_version",
    "state",
    "asset_manifest",
    "format",
  ]);
  requireId(request.revision_id);
  if (request.schema_version !== 1 || !formats.has(request.format as never)) {
    throw invalidInput("Revision export version or format is invalid");
  }
  parseComputedState(request.state);
  requireManifest(request.asset_manifest);
  return value as ExportRequest;
}

function parseComputedState(value: unknown): void {
  const state = requireRecord(value, [
    "state_bytes",
    "bytes_sha256",
    "state_vector",
    "state_hash",
    "state_hash_version",
    "complete_references",
    "warnings",
  ]);
  decodeBase64(state.state_bytes, ROOM_DOCUMENT_MAX_STATE_BYTES);
  requireSha256(state.bytes_sha256);
  decodeBase64(state.state_vector, 1 << 20);
  requireSha256(state.state_hash);
  if (state.state_hash_version !== 1) {
    throw invalidInput("Revision export state hash version is invalid");
  }
  requireReferences(state.complete_references);
  requireWarnings(state.warnings);
}

function requireManifest(value: unknown): void {
  if (!Array.isArray(value) || value.length > ROOM_DOCUMENT_MAX_REFERENCES) {
    throw invalidInput("Revision export Asset manifest is invalid");
  }
  const ids = new Set<string>();
  for (const entryValue of value) {
    const entry = requireRecord(
      entryValue,
      ["id", "media_type", "size_bytes", "sha256", "title"],
      ["title"],
    );
    requireId(entry.id);
    requireSha256(entry.sha256);
    if (
      ids.has(entry.id) ||
      typeof entry.media_type !== "string" ||
      entry.media_type.length < 1 ||
      entry.media_type.length > 255 ||
      typeof entry.size_bytes !== "number" ||
      !Number.isSafeInteger(entry.size_bytes) ||
      entry.size_bytes < 0 ||
      (entry.title !== undefined &&
        (typeof entry.title !== "string" || entry.title.length > 1024))
    ) {
      throw invalidInput("Revision export Asset manifest entry is invalid");
    }
    ids.add(entry.id);
  }
}

function requireReferences(value: unknown): void {
  const references = requireRecord(value, [
    "document_asset_ids",
    "document_thread_ids",
  ]);
  const lists = [references.document_asset_ids, references.document_thread_ids];
  if (
    lists.some(
      (ids) =>
        !Array.isArray(ids) ||
        ids.length > ROOM_DOCUMENT_MAX_REFERENCES ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => typeof id !== "string" || !validId(id)),
    ) ||
    lists.reduce<number>(
      (total, ids) => total + (Array.isArray(ids) ? ids.length : 0),
      0,
    ) > ROOM_DOCUMENT_MAX_REFERENCES
  ) {
    throw invalidInput("Revision export references are invalid");
  }
}

function requireWarnings(value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (warning) => typeof warning !== "string" || [...warning].length > 1024,
    )
  ) {
    throw invalidInput("Revision export warnings are invalid");
  }
}

function requireRecord(
  value: unknown,
  allowedKeys: string[],
  optionalKeys: string[] = [],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowedKeys.includes(key)) ||
    allowedKeys.some((key) => !optionalKeys.includes(key) && !(key in value))
  ) {
    throw invalidInput("Revision export object is invalid");
  }
  return value as Record<string, unknown>;
}

function decodeBase64(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw invalidInput("Revision export bytes must use canonical base64");
  }
  // Bound allocation before decoding. Avoid repeated-group regexes: V8 can
  // exhaust its stack on otherwise valid multi-megabyte Base64 strings.
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if ((value.length / 4) * 3 - padding > maxBytes) {
    throw new RuntimeInputError(
      "payload_too_large",
      "Revision export bytes exceed their limit",
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw invalidInput("Revision export bytes must use canonical base64");
  }
  return decoded;
}

function requireId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !validId(value)) {
    throw invalidInput("Revision export identifier is invalid");
  }
}

function validId(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && idPattern.test(value);
}

function requireSha256(value: unknown): asserts value is string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw invalidInput("Revision export SHA-256 evidence is invalid");
  }
}

function toModelManifestEntry(
  entry: components["schemas"]["ManifestEntry"],
): RoomDocumentAssetManifestEntry {
  return {
    id: entry.id,
    mediaType: entry.media_type,
    sizeBytes: entry.size_bytes,
    sha256: entry.sha256,
    ...(entry.title === undefined ? {} : { title: entry.title }),
  };
}

function toModelState(state: components["schemas"]["ComputedDocumentState"]) {
  return {
    stateBytes: decodeBase64(state.state_bytes, ROOM_DOCUMENT_MAX_STATE_BYTES),
    bytesSha256: state.bytes_sha256,
    stateVector: decodeBase64(state.state_vector, 1 << 20),
    stateHash: state.state_hash,
    stateHashVersion: state.state_hash_version as 1,
    completeReferences: {
      documentAssetIds: state.complete_references.document_asset_ids,
      documentThreadIds: state.complete_references.document_thread_ids,
    },
    warnings: state.warnings,
  };
}

function errorResponse(
  context: RuntimeContext,
  status: 400 | 413 | 422 | 500,
  code:
    | "invalid_request"
    | "internal_error"
    | "payload_too_large"
    | "unsupported_document"
    | "validation_failed",
  message: string,
): Response {
  return context.json({ code, message, retryable: false }, status);
}

function invalidInput(message: string): RuntimeInputError {
  return new RuntimeInputError("validation_failed", message);
}

function isModelError(error: unknown): error is Error & {
  code: "payload_too_large" | "unsupported_document" | "validation_failed";
} {
  return (
    error instanceof Error &&
    "code" in error &&
    ["payload_too_large", "unsupported_document", "validation_failed"].includes(
      String(error.code),
    )
  );
}
