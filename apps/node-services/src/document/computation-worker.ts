import { parentPort } from "node:worker_threads";

import {
  applyRoomDocumentSemanticMutation,
  attachRoomDocumentCommentAnchor,
  duplicateRoomDocumentState,
  exportRoomDocumentRevision,
  materializeRoomDocument,
  restoreRoomDocumentRevision,
} from "@linger/document-model";

import type { DocumentModelErrorCode } from "./computation-pool.js";
import { installDocumentRuntimeDOM } from "./server-dom.js";

installDocumentRuntimeDOM();

const computations = {
  materializeRoomDocument,
  restoreRoomDocumentRevision,
  duplicateRoomDocumentState,
  attachRoomDocumentCommentAnchor,
  applyRoomDocumentSemanticMutation,
  exportRoomDocumentRevision,
};

export type DocumentComputations = typeof computations;

const modelErrorCodes = new Set<string>([
  "payload_too_large",
  "unsupported_document",
  "validation_failed",
]);

if (parentPort === null) {
  throw new TypeError(
    "Document computation worker must run in a worker thread",
  );
}
const port = parentPort;

port.on("message", (request: { id: number; name: string; input: unknown }) => {
  void (async () => {
    try {
      if (!Object.hasOwn(computations, request.name)) {
        throw new Error("Unknown document computation");
      }
      const compute = computations[
        request.name as keyof DocumentComputations
      ] as unknown as (input: unknown) => unknown;
      const result = await compute(request.input);
      port.postMessage({ id: request.id, ok: true, result });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "computation failed";
      const code = modelErrorCode(error);
      port.postMessage(
        code === undefined
          ? { id: request.id, ok: false, message }
          : { id: request.id, ok: false, code, message },
      );
    }
  })();
});

function modelErrorCode(error: unknown): DocumentModelErrorCode | undefined {
  if (
    error instanceof Error &&
    "code" in error &&
    modelErrorCodes.has(String(error.code))
  ) {
    return String(error.code) as DocumentModelErrorCode;
  }
  return undefined;
}
