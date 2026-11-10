import { Worker } from "node:worker_threads";

import {
  installModelPackages,
  modelPackageNames,
  modelPackagesInstalled,
} from "../model-packages.js";
import { serviceModule } from "../paths.js";

export const DOCUMENT_NORMALIZER_NAME = "llm-wiki-document-markdown";
export const DOCUMENT_NORMALIZER_VERSION = "2";
export const MAX_OCR_PIXELS = 16_000_000;
export const MAX_DOCUMENT_PAGES = 100;
export const MAX_DOCUMENT_SOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_DOCUMENT_MARKDOWN_BYTES = 32 * 1024 * 1024;
// The same bytes always take as long again, so a conversion that runs out is
// terminal for that source version.
const DEFAULT_DOCUMENT_NORMALIZATION_TIMEOUT_MS = 5 * 60_000;
// One conversion runs at a time; past this many waiting requests the
// normalizer is busy and a caller retries later.
const MAX_QUEUED_DOCUMENT_NORMALIZATIONS = 32;
// Callers hold their source bytes until normalization settles, so admitted
// sources are capped by total size, not only by count; past this a caller
// retries later.
const MAX_ADMITTED_DOCUMENT_SOURCE_BYTES = 2 * MAX_DOCUMENT_SOURCE_BYTES;

export const PDF_MEDIA_TYPE = "application/pdf";
export const DOC_MEDIA_TYPE = "application/msword";
export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const ZIP_MEDIA_TYPE = "application/zip";
export const GZIP_MEDIA_TYPE = "application/gzip";
export const PNG_MEDIA_TYPE = "image/png";
export const SVG_MEDIA_TYPE = "image/svg+xml";

export type DocumentNormalizationErrorCode =
  | "DOCUMENT_NORMALIZATION_INVALID"
  | "DOCUMENT_SOURCE_TOO_LARGE"
  | "DOCUMENT_SOURCE_UNSUPPORTED"
  | "DOCUMENT_SOURCE_INVALID"
  | "DOCUMENT_SOURCE_EMPTY"
  | "DOCUMENT_MARKDOWN_TOO_LARGE"
  | "DOCUMENT_NORMALIZATION_TIMEOUT"
  | "DOCUMENT_NORMALIZATION_UNAVAILABLE";

export type DocumentNormalizationDisposition = "terminal" | "retryable";

const ERROR_DEFINITIONS: Record<
  DocumentNormalizationErrorCode,
  {
    disposition: DocumentNormalizationDisposition;
    message: string;
    status: 400 | 413 | 415 | 422 | 503;
  }
> = {
  DOCUMENT_NORMALIZATION_INVALID: {
    disposition: "terminal",
    message: "Document normalization request is invalid",
    status: 400,
  },
  DOCUMENT_SOURCE_TOO_LARGE: {
    disposition: "terminal",
    message: "Document source exceeds extraction limits",
    status: 413,
  },
  DOCUMENT_SOURCE_UNSUPPORTED: {
    disposition: "terminal",
    message: "Document source media type is unsupported",
    status: 415,
  },
  DOCUMENT_SOURCE_INVALID: {
    disposition: "terminal",
    message: "Document source is corrupt or cannot be decoded",
    status: 422,
  },
  DOCUMENT_SOURCE_EMPTY: {
    disposition: "terminal",
    message: "Document source has no extractable text",
    status: 422,
  },
  DOCUMENT_MARKDOWN_TOO_LARGE: {
    disposition: "terminal",
    message: "Normalized Markdown exceeds the 32 MiB limit",
    status: 422,
  },
  DOCUMENT_NORMALIZATION_TIMEOUT: {
    disposition: "terminal",
    message: "Document normalization timed out",
    status: 422,
  },
  DOCUMENT_NORMALIZATION_UNAVAILABLE: {
    disposition: "retryable",
    message: "Document normalizer is temporarily unavailable",
    status: 503,
  },
};

export class DocumentNormalizationError extends Error {
  readonly code: DocumentNormalizationErrorCode;
  readonly disposition: DocumentNormalizationDisposition;
  readonly status: 400 | 413 | 415 | 422 | 503;

  constructor(code: DocumentNormalizationErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = "DocumentNormalizationError";
    this.code = code;
    this.disposition = definition.disposition;
    this.status = definition.status;
  }
}

export interface DocumentNormalizationInput {
  archiveDepth?: number;
  filename?: string;
  mediaType: string;
  representationFormat?: string;
  source: Uint8Array;
}

/** One stored source; its filename picks the extractor when the media type is generic. */
export interface DocumentNormalizationRequest {
  filename: string;
  mediaType: string;
  representationFormat?: string;
  source: Uint8Array;
}

export interface DocumentNormalizer {
  /**
   * Converts one source to canonical Markdown. Aborting the signal stops
   * waiting or converting and fails as unavailable.
   */
  normalizeDocument(
    request: DocumentNormalizationRequest,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

interface WorkerSuccess {
  markdown: ArrayBuffer;
  ok: true;
}

interface WorkerFailure {
  code: DocumentNormalizationErrorCode;
  ok: false;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

type DocumentNormalizationExecutor = (
  input: DocumentNormalizationInput,
  signal: AbortSignal,
) => Promise<Uint8Array>;

interface WorkerDocumentNormalizerOptions {
  execute?: DocumentNormalizationExecutor;
  /** OCR's language data, when the runtime ships it separately. */
  installModels?: () => Promise<void>;
  maxAdmittedBytes?: number;
  maxQueued?: number;
  /** A failed model install; conversions that need OCR fail as unavailable. */
  onModelsUnavailable?: (error: unknown) => void;
  timeoutMs?: number;
}

/**
 * The process's one normalizer. Text formats convert in process; the rest
 * convert in an isolated worker, one at a time, because OCR memory (WASM,
 * canvas and image decoding) sits outside the worker heap limit. A request
 * waits for the worker at most one timeout and fails as unavailable; the
 * conversion itself then has its own timeout, which is terminal.
 */
export class WorkerDocumentNormalizer implements DocumentNormalizer {
  readonly #execute: DocumentNormalizationExecutor;
  readonly #installModels: () => Promise<void>;
  readonly #onModelsUnavailable: (error: unknown) => void;
  readonly #maxAdmittedBytes: number;
  readonly #maxQueued: number;
  readonly #timeoutMs: number;
  readonly #waiting: (() => void)[] = [];
  #admittedBytes = 0;
  #converting = false;

  constructor(options: WorkerDocumentNormalizerOptions = {}) {
    this.#execute = options.execute ?? executeInWorker;
    this.#installModels = options.installModels ?? installOcrModels;
    this.#onModelsUnavailable = options.onModelsUnavailable ?? (() => {});
    this.#maxQueued = options.maxQueued ?? MAX_QUEUED_DOCUMENT_NORMALIZATIONS;
    this.#timeoutMs =
      options.timeoutMs ?? DEFAULT_DOCUMENT_NORMALIZATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("Document normalization timeout must be positive");
    }
    this.#maxAdmittedBytes =
      options.maxAdmittedBytes ?? MAX_ADMITTED_DOCUMENT_SOURCE_BYTES;
    if (
      !Number.isSafeInteger(this.#maxAdmittedBytes) ||
      this.#maxAdmittedBytes < MAX_DOCUMENT_SOURCE_BYTES
    ) {
      throw new Error(
        "Document normalization byte budget must admit one maximum source",
      );
    }
  }

  async normalizeDocument(
    request: DocumentNormalizationRequest,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const size = request.source.byteLength;
    if (size > MAX_DOCUMENT_SOURCE_BYTES) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
    }
    if (
      this.#admittedBytes > 0 &&
      this.#admittedBytes + size > this.#maxAdmittedBytes
    ) {
      throw unavailable();
    }
    this.#admittedBytes += size;
    try {
      const core = await import("./document-normalizer-core.js");
      if (core.isInProcessDocumentSource(request)) {
        return await core.normalizeDocumentContent(request);
      }
      // Outside the conversion's deadline: the first install downloads.
      await this.#installModels().catch(this.#onModelsUnavailable);
      const release = await this.#acquireWorker(signal);
      try {
        return await this.#convert(request, signal);
      } finally {
        release();
      }
    } finally {
      this.#admittedBytes -= size;
    }
  }

  #acquireWorker(signal: AbortSignal | undefined): Promise<() => void> {
    const release = (): void => {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#converting = false;
    };
    if (signal?.aborted) return Promise.reject(unavailable());
    if (!this.#converting) {
      this.#converting = true;
      return Promise.resolve(release);
    }
    if (this.#waiting.length >= this.#maxQueued) {
      return Promise.reject(unavailable());
    }
    return new Promise((resolve, reject) => {
      const start = (): void => {
        stopWaiting();
        resolve(release);
      };
      const leave = (): void => {
        const index = this.#waiting.indexOf(start);
        if (index >= 0) this.#waiting.splice(index, 1);
        stopWaiting();
        reject(unavailable());
      };
      const timer = setTimeout(leave, this.#timeoutMs);
      timer.unref();
      const stopWaiting = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", leave);
      };
      signal?.addEventListener("abort", leave, { once: true });
      this.#waiting.push(start);
    });
  }

  async #convert(
    request: DocumentNormalizationRequest,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(
          new DocumentNormalizationError("DOCUMENT_NORMALIZATION_TIMEOUT"),
        );
        controller.abort();
      }, this.#timeoutMs);
      timeout.unref();
    });
    try {
      const markdown = await Promise.race([
        this.#execute(request, controller.signal),
        timedOut,
      ]);
      if (markdown.byteLength > MAX_DOCUMENT_MARKDOWN_BYTES) {
        throw new DocumentNormalizationError("DOCUMENT_MARKDOWN_TOO_LARGE");
      }
      return markdown;
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

async function installOcrModels(): Promise<void> {
  const names = modelPackageNames("ocr");
  if (!modelPackagesInstalled(names)) await installModelPackages(names);
}

function unavailable(): DocumentNormalizationError {
  return new DocumentNormalizationError("DOCUMENT_NORMALIZATION_UNAVAILABLE");
}

async function executeInWorker(
  input: DocumentNormalizationInput,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const worker = new Worker(
    serviceModule("document-normalizer/document-normalizer-worker"),
    {
      resourceLimits: {
        maxOldGenerationSizeMb: 384,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    },
  );
  const source = Uint8Array.from(input.source);

  return await new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const finish = (result: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
      result();
      void worker.terminate();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(
          new DocumentNormalizationError("DOCUMENT_NORMALIZATION_UNAVAILABLE"),
        );
      });
    };

    signal.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message: WorkerResponse) => {
      // Node --watch also sends dependency notifications through this port.
      if (!message || typeof message.ok !== "boolean") return;
      finish(() => {
        if (!message.ok) {
          reject(new DocumentNormalizationError(message.code));
          return;
        }
        resolve(new Uint8Array(message.markdown));
      });
    });
    worker.once("error", () => {
      finish(() => {
        reject(
          new DocumentNormalizationError("DOCUMENT_NORMALIZATION_UNAVAILABLE"),
        );
      });
    });
    worker.once("exit", () => {
      if (settled) return;
      finish(() => {
        reject(
          new DocumentNormalizationError("DOCUMENT_NORMALIZATION_UNAVAILABLE"),
        );
      });
    });

    if (signal.aborted) {
      onAbort();
      return;
    }
    worker.postMessage(
      {
        filename: input.filename,
        mediaType: input.mediaType,
        representationFormat: input.representationFormat,
        source: source.buffer,
      },
      [source.buffer],
    );
  });
}
