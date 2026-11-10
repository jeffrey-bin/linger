/// <reference lib="webworker" />

import {
  DocumentAssetChangedError,
  hashBlobIncrementally,
} from "./document-asset-hash";
import type {
  DocumentAssetHashRequest,
  DocumentAssetHashResponse,
} from "./document-asset-hash-protocol";

self.addEventListener(
  "message",
  (event: MessageEvent<DocumentAssetHashRequest>) => {
    void (async () => {
      const { file, requestId } = event.data;
      try {
        const result = await hashBlobIncrementally(file);
        self.postMessage({
          ...result,
          kind: "hashed",
          requestId,
        } satisfies DocumentAssetHashResponse);
      } catch (error) {
        self.postMessage({
          kind: "failed",
          message:
            error instanceof Error
              ? error.message
              : "Document Asset could not be read.",
          requestId,
          stage: error instanceof DocumentAssetChangedError ? "read" : "hash",
        } satisfies DocumentAssetHashResponse);
      }
    })();
  },
);
