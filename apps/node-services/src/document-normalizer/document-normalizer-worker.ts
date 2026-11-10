import { parentPort } from "node:worker_threads";

import type { DocumentNormalizationInput } from "./document-normalizer.js";

// Workers do not inherit the parent's TS loader hooks in local dev or Vitest.
// Production uses the compiled JS entry and has no dependency on tsx.
if (import.meta.url.endsWith(".ts")) {
  const { register } = await import("tsx/esm/api");
  register();
}
const { normalizeDocumentContent } =
  await import("./document-normalizer-core.js");
const { DocumentNormalizationError } = await import("./document-normalizer.js");

interface WorkerRequest {
  filename?: string;
  mediaType: string;
  representationFormat?: string;
  source: ArrayBuffer;
}

if (!parentPort) {
  throw new Error("Document normalizer worker requires a parent port");
}

const port = parentPort;
port.once("message", (request: WorkerRequest) => {
  void normalize(request);
});

async function normalize(request: WorkerRequest): Promise<void> {
  try {
    const input: DocumentNormalizationInput = {
      filename: request.filename,
      mediaType: request.mediaType,
      representationFormat: request.representationFormat,
      source: new Uint8Array(request.source),
    };
    const markdown = await normalizeDocumentContent(input);
    const transferable = new ArrayBuffer(markdown.byteLength);
    new Uint8Array(transferable).set(markdown);
    port.postMessage({ markdown: transferable, ok: true }, [transferable]);
  } catch (error) {
    const code =
      error instanceof DocumentNormalizationError
        ? error.code
        : "DOCUMENT_NORMALIZATION_UNAVAILABLE";
    port.postMessage({ code, ok: false });
  } finally {
    port.close();
  }
}
