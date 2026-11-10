import { isCanonicalBase64 } from "./base64.js";
import { timingSafeEqual } from "node:crypto";

import {
  ROOM_DOCUMENT_MAX_REFERENCES,
  type RoomDocumentSemanticBlock,
  type RoomDocumentSemanticOperation,
} from "@linger/document-model";
import {
  registerDocumentRuntimeRoutes,
  type DocumentRuntimeHandlers,
} from "@linger/wire-contracts/node-services-internal/server";
import type { components } from "@linger/wire-contracts/node-services-internal/types";
import { Hono } from "hono";

import type { DocumentComputation } from "./computation-pool.js";
import {
  DocumentNotFoundError,
  type ComputedDocumentChange,
  type DocumentChangeComputation,
  type DocumentChangeCoordinator,
} from "./document-changes.js";
import { exportDocument } from "./export.js";
import { documentLogger } from "./log.js";
import { isRecord } from "@linger/service-kit";
import { sha256Hex } from "@linger/service-kit/node";
import { RuntimeInputError, sha256Pattern } from "./runtime-input.js";

type ImportRequest = components["schemas"]["ImportDocumentRequest"];
type ApplyRequest = components["schemas"]["ApplyDocumentChangeRequest"];
type SemanticChange = components["schemas"]["SemanticDocumentChange"];
type InternalErrorCode = components["schemas"]["InternalErrorCode"];
type RuntimeContext = Parameters<DocumentRuntimeHandlers["importDocument"]>[0];

type DisconnectRequest =
  components["schemas"]["DisconnectDocumentConnectionsRequest"];

export interface DocumentRuntimeAppOptions {
  teamHubToken: string;
  // Applies TeamHub's server changes to the online bodies.
  changes?: DocumentChangeCoordinator;
  // Closes open connections after TeamHub committed a permission change.
  disconnect?: (documentId: string, actorId?: string) => void;
  computation: DocumentComputation;
}

export function createDocumentRuntimeApp(
  options: DocumentRuntimeAppOptions,
): Hono {
  if (options.teamHubToken.trim() === "") {
    throw new TypeError("Document Runtime TeamHub token is required");
  }
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ status: "ok" }));
  // The Runtime holds no state TeamHub waits on, so a live process is ready.
  app.get("/readyz", (context) => context.json({ status: "ok" }));

  const handlers: DocumentRuntimeHandlers = {
    importDocument: (context) => importDocument(context, options.computation),
    exportDocument: (context) => exportDocument(context, options.computation),
    applyDocumentChange: options.changes
      ? (context) =>
          applyDocumentChange(context, options.changes!, options.computation)
      : notImplemented,
    disconnectDocumentConnections: options.disconnect
      ? (context) => disconnectDocumentConnections(context, options.disconnect!)
      : notImplemented,
    methodNotAllowed: (context) =>
      internalError(
        context,
        405,
        "invalid_request",
        "Document Runtime operation requires POST",
        false,
      ),
  };
  registerDocumentRuntimeRoutes(app, handlers, {
    authenticate: ({ token }) =>
      tokensEqual(token, options.teamHubToken) ? { subject: "teamhub" } : null,
  });

  return app;
}

async function disconnectDocumentConnections(
  context: Parameters<
    DocumentRuntimeHandlers["disconnectDocumentConnections"]
  >[0],
  disconnect: (documentId: string, actorId?: string) => void,
): Promise<Response> {
  const documentId = context.req.param("documentId") ?? "";
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    body = undefined;
  }
  const actorId = isRecord(body)
    ? (body as DisconnectRequest).actor_id
    : undefined;
  if (
    !internalIDPattern.test(documentId) ||
    !isRecord(body) ||
    Object.keys(body).some((key) => key !== "actor_id") ||
    (actorId !== undefined &&
      (typeof actorId !== "string" || !internalIDPattern.test(actorId)))
  ) {
    return internalError(
      context,
      400,
      "invalid_request",
      "Document disconnect request is invalid",
      false,
    );
  }
  disconnect(documentId, actorId);
  return context.body(null, 204);
}

async function importDocument(
  context: RuntimeContext,
  computation: DocumentComputation,
): Promise<Response> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return internalError(
      context,
      400,
      "invalid_request",
      "Import request body must be valid JSON",
      false,
    );
  }
  try {
    const request = parseImportRequest(body);
    const sourceBytes =
      request.source_bytes === undefined
        ? undefined
        : decodeBase64(request.source_bytes);
    if (request.source_kind === "document_state") {
      const result = await computation.run("duplicateRoomDocumentState", {
        duplicateOperationId: request.operation_id,
        stateBytes: sourceBytes!,
        assetIdMap: Object.fromEntries(
          (request.asset_mappings ?? []).map((mapping) => [
            mapping.source_asset_id,
            mapping.target_asset_id,
          ]),
        ),
      });
      return context.json({
        state_bytes: Buffer.from(result.stateBytes).toString("base64"),
        bytes_sha256: result.stateBytesSha256,
        state_vector: Buffer.from(result.stateVector).toString("base64"),
        state_hash: result.stateHash,
        state_hash_version: result.stateHashVersion,
        complete_references: {
          document_asset_ids: result.completeReferences.documentAssetIds,
          document_thread_ids: result.completeReferences.documentThreadIds,
        },
        warnings: [],
      });
    }
    const computed = await computation.run("materializeRoomDocument", {
      materializationId: request.operation_id,
      schemaVersion: request.schema_version,
      sourceKind: request.source_kind,
      ...(sourceBytes === undefined ? {} : { sourceBytes }),
      allowedDocumentAssetIds: request.allowed_document_asset_ids ?? [],
    });
    return context.json({
      state_bytes: Buffer.from(computed.stateBytes).toString("base64"),
      bytes_sha256: computed.bytesSha256,
      state_vector: Buffer.from(computed.stateVector).toString("base64"),
      state_hash: computed.stateHash,
      state_hash_version: computed.stateHashVersion,
      complete_references: {
        document_asset_ids: computed.completeReferences.documentAssetIds,
        document_thread_ids: computed.completeReferences.documentThreadIds,
      },
      warnings: computed.warnings,
    });
  } catch (error) {
    return modelErrorResponse(context, error);
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const textSourceKinds = new Set(["markdown", "plain_text", "sanitized_html"]);

function parseImportRequest(value: unknown): ImportRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "operation_id",
      "schema_version",
      "source_kind",
      "source_bytes",
      "allowed_document_asset_ids",
      "asset_mappings",
    ]) ||
    typeof value.schema_version !== "number" ||
    !Number.isInteger(value.schema_version) ||
    (value.source_bytes !== undefined &&
      typeof value.source_bytes !== "string") ||
    (value.allowed_document_asset_ids !== undefined &&
      !isIDArray(
        value.allowed_document_asset_ids,
        ROOM_DOCUMENT_MAX_REFERENCES,
        true,
      ))
  ) {
    throw invalidRequest("Import request is invalid");
  }
  const kind = value.source_kind;
  if (kind === "document_state") {
    if (
      !isID(value.operation_id) ||
      value.source_bytes === undefined ||
      value.allowed_document_asset_ids !== undefined ||
      !Array.isArray(value.asset_mappings) ||
      value.asset_mappings.length > ROOM_DOCUMENT_MAX_REFERENCES
    ) {
      throw invalidRequest("Document state import is invalid");
    }
    const sourceIds = new Set<string>();
    const targetIds = new Set<string>();
    for (const mapping of value.asset_mappings) {
      if (
        !isRecord(mapping) ||
        !hasOnlyKeys(mapping, ["source_asset_id", "target_asset_id"]) ||
        !isID(mapping.source_asset_id) ||
        !isID(mapping.target_asset_id) ||
        sourceIds.has(mapping.source_asset_id) ||
        targetIds.has(mapping.target_asset_id)
      ) {
        throw invalidRequest(
          "Document state import Asset mappings are invalid",
        );
      }
      sourceIds.add(mapping.source_asset_id);
      targetIds.add(mapping.target_asset_id);
    }
    return value as unknown as ImportRequest;
  }
  if (
    (kind !== "blank" && !textSourceKinds.has(String(kind))) ||
    typeof value.operation_id !== "string" ||
    !uuidPattern.test(value.operation_id) ||
    value.asset_mappings !== undefined
  ) {
    throw invalidRequest("Import request is invalid");
  }
  return value as unknown as ImportRequest;
}

async function applyDocumentChange(
  context: Parameters<DocumentRuntimeHandlers["applyDocumentChange"]>[0],
  changes: DocumentChangeCoordinator,
  computation: DocumentComputation,
): Promise<Response> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return internalError(
      context,
      400,
      "invalid_request",
      "Document change body must be valid JSON",
      false,
    );
  }
  let request: ApplyRequest;
  let compute: DocumentChangeComputation;
  const documentId = context.req.param("documentId") ?? "";
  try {
    request = parseApplyRequest(documentId, body);
    compute = changeComputation(request, computation);
  } catch (error) {
    return modelErrorResponse(context, error);
  }
  try {
    const result = await changes.apply({
      documentId,
      operationId: request.operation_id,
      actorId: request.actor_id,
      ...(request.expected_seq === undefined
        ? {}
        : { expectedSeq: request.expected_seq }),
      compute,
    });
    if (result.status === "conflicted") {
      return context.json({ status: result.status, reason: result.reason });
    }
    return context.json({
      status: result.status,
      seq: result.seq,
      state_hash: result.stateHash,
      title: result.title,
      complete_references: {
        document_asset_ids: result.assetIds,
        document_thread_ids: result.threadIds,
      },
    });
  } catch (error) {
    if (error instanceof DocumentNotFoundError) {
      return internalError(context, 404, "not_found", error.message, false);
    }
    if (isDocumentModelError(error) || error instanceof RuntimeInputError) {
      return modelErrorResponse(context, error);
    }
    documentLogger().log("error", "document.change_failed", {
      document_id: documentId,
      message: error instanceof Error ? error.message : String(error),
    });
    return internalError(
      context,
      503,
      "runtime_unavailable",
      "The Document change was not applied",
      true,
    );
  }
}

function changeComputation(
  request: ApplyRequest,
  computation: DocumentComputation,
): DocumentChangeComputation {
  const change = request.change;
  switch (change.kind) {
    case "semantic":
      return async (stateBytes) => {
        const result = await computation.run(
          "applyRoomDocumentSemanticMutation",
          {
            mutationId: request.operation_id,
            schemaVersion: change.schema_version,
            currentTitle: change.current_title,
            stateBytes,
            allowedDocumentAssetIds: change.allowed_document_asset_ids,
            operations: semanticModelOperations(change.operations),
          },
        );
        if (result.status === "conflicted") return { conflict: result.reason };
        return computedChange(result, result.title);
      };
    case "restore": {
      const targetStateBytes = decodeBase64(change.target_state_bytes);
      if (sha256Hex(targetStateBytes) !== change.target_state_bytes_sha256) {
        throw invalidRequest(
          "History restore Revision bytes do not match their declared hash",
        );
      }
      return async (currentStateBytes) =>
        computedChange(
          await computation.run("restoreRoomDocumentRevision", {
            restoreOperationId: request.operation_id,
            currentStateBytes,
            targetStateBytes,
          }),
          "",
        );
    }
    case "comment_anchor":
      return async (stateBytes) =>
        computedChange(
          await computation.run("attachRoomDocumentCommentAnchor", {
            attachmentOperationId: request.operation_id,
            threadId: change.thread_id,
            stateBytes,
            quotedText: change.quoted_text,
            blockId: change.block_id,
            contextBefore: change.context_before,
            contextAfter: change.context_after,
          }),
          "",
        );
  }
}

function computedChange(
  result: {
    update: Uint8Array;
    stateBytes: Uint8Array;
    endStateVector: Uint8Array;
    completeReferences: {
      documentAssetIds: string[];
      documentThreadIds: string[];
    };
  },
  title: string,
): ComputedDocumentChange {
  return {
    update: result.update,
    stateBytes: result.stateBytes,
    stateVector: result.endStateVector,
    title,
    assetIds: result.completeReferences.documentAssetIds,
    threadIds: result.completeReferences.documentThreadIds,
  };
}

function parseApplyRequest(documentId: string, value: unknown): ApplyRequest {
  if (
    !isID(documentId) ||
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "operation_id",
      "actor_id",
      "expected_seq",
      "change",
    ]) ||
    !isID(value.operation_id) ||
    !isID(value.actor_id) ||
    (value.expected_seq !== undefined &&
      (typeof value.expected_seq !== "number" ||
        !Number.isSafeInteger(value.expected_seq) ||
        value.expected_seq < 0)) ||
    !isRecord(value.change)
  ) {
    throw invalidRequest("Document change request is invalid");
  }
  const change = value.change;
  switch (change.kind) {
    case "semantic":
      if (!isSemanticChange(change)) {
        throw invalidRequest("Semantic Document change is invalid");
      }
      break;
    case "restore":
      if (
        !hasOnlyKeys(change, [
          "kind",
          "target_state_bytes",
          "target_state_bytes_sha256",
        ]) ||
        typeof change.target_state_bytes !== "string" ||
        typeof change.target_state_bytes_sha256 !== "string" ||
        !sha256Pattern.test(change.target_state_bytes_sha256)
      ) {
        throw invalidRequest("History restore change is invalid");
      }
      break;
    case "comment_anchor":
      if (
        !hasOnlyKeys(change, [
          "kind",
          "thread_id",
          "quoted_text",
          "block_id",
          "context_before",
          "context_after",
        ]) ||
        !isID(change.thread_id) ||
        typeof change.quoted_text !== "string" ||
        change.quoted_text.trim() === "" ||
        Array.from(change.quoted_text).length > 10_000 ||
        !isID(change.block_id) ||
        typeof change.context_before !== "string" ||
        Array.from(change.context_before).length > 2_000 ||
        typeof change.context_after !== "string" ||
        Array.from(change.context_after).length > 2_000
      ) {
        throw invalidRequest("Comment anchor change is invalid");
      }
      break;
    default:
      throw invalidRequest("Document change kind is unsupported");
  }
  return value as unknown as ApplyRequest;
}

function isSemanticChange(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      "kind",
      "schema_version",
      "current_title",
      "allowed_document_asset_ids",
      "operations",
    ]) &&
    value.schema_version === "blocknote-semantic-v1" &&
    isTitle(value.current_title) &&
    isIDArray(
      value.allowed_document_asset_ids,
      ROOM_DOCUMENT_MAX_REFERENCES,
      true,
    ) &&
    Array.isArray(value.operations) &&
    value.operations.length >= 1 &&
    value.operations.length <= 64 &&
    new TextEncoder().encode(JSON.stringify(value.operations)).byteLength <=
      (value.operations.some(
        (op: unknown) =>
          isRecord(op) &&
          (op.kind === "replace_body_html" ||
            op.kind === "replace_body_blocks"),
      )
        ? 8 << 20
        : 256 << 10) &&
    value.operations.every(isSemanticOperation)
  );
}

const internalIDPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isNativeEditOperation(value: Record<string, unknown>): boolean {
  const fields: Record<string, string[]> = {
    append: ["content"],
    str_replace: ["content", "pattern", "block_id"],
    block_insert_before: ["content", "block_id"],
    block_insert_after: ["content", "block_id"],
    block_replace: ["content", "block_id", "start_block_id", "end_block_id"],
    block_delete: ["block_id", "start_block_id", "end_block_id"],
    set_title: ["title"],
    image_insert_after: ["block_id", "asset_id", "caption"],
    image_replace: ["block_id", "asset_id", "caption"],
    file_insert_after: ["block_id", "asset_id", "name"],
  };
  const allowed =
    typeof value.command === "string" ? fields[value.command] : undefined;
  return (
    allowed !== undefined &&
    value.parser_version === "markdown-v1" &&
    hasOnlyKeys(value, ["kind", "parser_version", "command", ...allowed]) &&
    Object.entries(value).every(
      ([key, entry]) =>
        ["kind", "parser_version", "command"].includes(key) ||
        typeof entry === "string",
    )
  );
}

function isSemanticOperation(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "edit_document":
      return isNativeEditOperation(value);
    case "replace_body_blocks":
      return (
        hasOnlyKeys(value, ["kind", "blocks"]) &&
        isBlockArray(value.blocks, true) &&
        Buffer.byteLength(JSON.stringify(value.blocks)) <= 1 << 20
      );
    case "replace_body_html":
      return (
        hasOnlyKeys(value, ["kind", "html"]) &&
        typeof value.html === "string" &&
        value.html.length > 0 &&
        Buffer.byteLength(value.html) <= 1 << 20
      );
    case "set_title":
      return hasOnlyKeys(value, ["kind", "title"]) && isTitle(value.title);
    case "append_blocks":
      return (
        hasOnlyKeys(value, ["kind", "blocks"]) &&
        isBlockArray(value.blocks, true)
      );
    case "insert_blocks":
      return (
        hasOnlyKeys(value, ["kind", "position", "stable_block_id", "blocks"]) &&
        (value.position === "before" || value.position === "after") &&
        isID(value.stable_block_id) &&
        isBlockArray(value.blocks, true)
      );
    case "replace_blocks":
      return (
        hasOnlyKeys(value, ["kind", "stable_block_ids", "blocks"]) &&
        isIDArray(value.stable_block_ids, 2048, false) &&
        value.stable_block_ids.length > 0 &&
        isBlockArray(value.blocks, false)
      );
    case "update_block":
      return (
        hasOnlyKeys(value, ["kind", "stable_block_id", "block"]) &&
        isID(value.stable_block_id) &&
        isRecord(value.block)
      );
    case "delete_blocks":
      return (
        hasOnlyKeys(value, ["kind", "stable_block_ids"]) &&
        isIDArray(value.stable_block_ids, 2048, false) &&
        value.stable_block_ids.length > 0
      );
    case "replace_comment_text":
      return (
        hasOnlyKeys(value, ["kind", "thread_id", "replacement"]) &&
        isID(value.thread_id) &&
        typeof value.replacement === "string" &&
        value.replacement.length >= 1 &&
        value.replacement.length <= 50_000
      );
    default:
      return false;
  }
}

function semanticModelOperations(
  operations: SemanticChange["operations"],
): RoomDocumentSemanticOperation[] {
  return operations.map((operation) => {
    const value = operation as unknown as Record<string, unknown>;
    switch (value.kind) {
      case "edit_document":
        return value as unknown as RoomDocumentSemanticOperation;
      case "replace_body_blocks":
        return {
          kind: "replace_body_blocks",
          blocks: value.blocks as RoomDocumentSemanticBlock[],
        };
      case "replace_body_html":
        return { kind: "replace_body_html", html: value.html as string };
      case "set_title":
        return { kind: "set_title", title: value.title as string };
      case "append_blocks":
        return {
          kind: "append_blocks",
          blocks: value.blocks as RoomDocumentSemanticBlock[],
        };
      case "insert_blocks":
        return {
          kind: "insert_blocks",
          position: value.position as "before" | "after",
          stableBlockId: value.stable_block_id as string,
          blocks: value.blocks as RoomDocumentSemanticBlock[],
        };
      case "replace_blocks":
        return {
          kind: "replace_blocks",
          stableBlockIds: value.stable_block_ids as string[],
          blocks: value.blocks as RoomDocumentSemanticBlock[],
        };
      case "update_block":
        return {
          kind: "update_block",
          stableBlockId: value.stable_block_id as string,
          block: value.block as RoomDocumentSemanticBlock,
        };
      case "delete_blocks":
        return {
          kind: "delete_blocks",
          stableBlockIds: value.stable_block_ids as string[],
        };
      case "replace_comment_text":
        return {
          kind: "replace_comment_text",
          threadId: value.thread_id as string,
          replacement: value.replacement as string,
        };
      default:
        throw invalidRequest("Semantic mutation operation is unsupported");
    }
  });
}

function isBlockArray(
  value: unknown,
  requireNonempty: boolean,
): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    (!requireNonempty || value.length > 0) &&
    value.length <= 2048 &&
    value.every(isRecord)
  );
}

function isIDArray(
  value: unknown,
  maximum: number,
  unique: boolean,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(isID) &&
    (!unique || new Set(value).size === value.length)
  );
}

function isID(value: unknown): value is string {
  return typeof value === "string" && internalIDPattern.test(value);
}

function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function invalidRequest(message: string): RuntimeInputError {
  return new RuntimeInputError("validation_failed", message);
}

function decodeBase64(value: string): Uint8Array {
  const maxDecodedBytes = 32 << 20;
  const maxEncodedBytes = Math.ceil(maxDecodedBytes / 3) * 4;
  if (value.length > maxEncodedBytes || !isCanonicalBase64(value)) {
    throw new RuntimeInputError(
      "validation_failed",
      "Document source bytes must use canonical base64",
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maxDecodedBytes) {
    throw new RuntimeInputError(
      "payload_too_large",
      "Document source exceeds 32 MiB",
    );
  }
  return decoded;
}

function tokensEqual(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
}

function notImplemented(context: RuntimeContext): Response {
  return internalError(
    context,
    501,
    "internal_error",
    "Document Runtime operation is not configured",
    false,
  );
}

function modelErrorResponse(context: RuntimeContext, error: unknown): Response {
  if (isDocumentModelError(error)) {
    const status = error.code === "payload_too_large" ? 413 : 422;
    return internalError(context, status, error.code, error.message, false);
  }
  return internalError(
    context,
    500,
    "internal_error",
    "Document Runtime computation failed",
    false,
  );
}

function isDocumentModelError(error: unknown): error is Error & {
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

function internalError(
  context: RuntimeContext,
  status: 400 | 404 | 405 | 413 | 422 | 500 | 501 | 503,
  code: InternalErrorCode,
  message: string,
  retryable: boolean,
): Response {
  return context.json({ code, message, retryable }, status);
}
