import {
  createRoomDocumentAssetReference,
  parseRoomDocumentAssetReference,
} from "@linger/document-model";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { idempotencyHeader, teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

import documentAssetHashWorkerUrl from "./document-asset-hash-worker.ts?worker&url";
import { hashBlobIncrementally } from "./document-asset-hash";
import {
  documentAssetHashTimeoutMs,
  type DocumentAssetHashRequest,
  type DocumentAssetHashResponse,
} from "./document-asset-hash-protocol";

const browserRenderableAssetMediaTypes = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-icon",
  "video/mp4",
  "video/ogg",
  "video/webm",
]);

const maxRoomDocumentAssetBytes = 50 << 20;

export type DocumentAssetUploadStage =
  | "content-upload"
  | "hash"
  | "plan"
  | "read";

export class DocumentAssetUploadError extends Error {
  constructor(
    readonly stage: DocumentAssetUploadStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DocumentAssetUploadError";
  }
}

export async function uploadRoomDocumentAsset(
  client: TeamHubClient,
  documentId: string,
  file: File,
  blockId?: string,
): Promise<string> {
  if (file.size < 1 || file.size > maxRoomDocumentAssetBytes) {
    throw new Error("Document Asset size is outside the supported range.");
  }
  return roomDocumentAssetUploadGate.run(async () => {
    const hashed = await hashDocumentAsset(file);
    if (hashed.bytesRead !== file.size) {
      throw new DocumentAssetUploadError(
        "read",
        "Document Asset changed while it was being read.",
      );
    }
    const fileSha256 = hashed.sha256;
    const mediaType = file.type || "application/octet-stream";
    const idempotencyHash = await sha256SmallValue(
      new TextEncoder().encode(
        JSON.stringify([
          documentId,
          blockId ?? "",
          file.name,
          mediaType,
          file.size,
          fileSha256,
        ]),
      ),
    );
    const planned = await runDocumentAssetStage("plan", () =>
      teamHubData(
        client.api.POST("/v0/documents/{documentId}/assets", {
          params: {
            path: { documentId },
            header: idempotencyHeader(`web:document-asset:${idempotencyHash}`),
          },
          body: {
            filename: file.name,
            media_type: mediaType,
            sha256: fileSha256,
            size_bytes: file.size,
          },
        }),
      ),
    );
    const available = await runDocumentAssetStage("content-upload", () =>
      client.uploadRoomDocumentAssetContent(planned.id, file),
    );
    if (
      available.id !== planned.id ||
      available.sha256 !== fileSha256 ||
      available.size_bytes !== file.size ||
      available.status !== "available"
    ) {
      throw new DocumentAssetUploadError(
        "content-upload",
        "TeamHub returned inconsistent Document Asset evidence.",
      );
    }
    return createRoomDocumentAssetReference(available.id);
  });
}

export interface RoomDocumentAssetUrlResolver {
  prime(reference: string, content: Blob): boolean;
  retain(): () => void;
  resolve(reference: string): Promise<string>;
}

interface RoomDocumentAssetUrlResolverOptions {
  maxConcurrentDownloads?: number;
  maxResidentBytes?: number;
}

export function createRoomDocumentAssetUrlResolver(
  client: TeamHubClient,
  options: RoomDocumentAssetUrlResolverOptions = {},
): RoomDocumentAssetUrlResolver {
  const pendingByAsset = new Map<string, Promise<string>>();
  const objectUrls = new Set<string>();
  const downloadGate = new AsyncGate(options.maxConcurrentDownloads ?? 2);
  const maxResidentBytes = options.maxResidentBytes ?? 128 << 20;
  let residentBytes = 0;
  let activeRetainers = 0;
  let disposalGeneration = 0;
  let disposed = false;

  return {
    prime(reference, content) {
      if (disposed || content.size < 1) {
        return false;
      }
      const assetId = parseRoomDocumentAssetReference(reference);
      if (
        assetId === undefined ||
        pendingByAsset.has(assetId) ||
        content.size > maxRoomDocumentAssetBytes ||
        content.size > maxResidentBytes - residentBytes
      ) {
        return false;
      }
      let objectUrl: string;
      try {
        objectUrl = URL.createObjectURL(browserSafeAssetBlob(content));
      } catch {
        return false;
      }
      residentBytes += content.size;
      objectUrls.add(objectUrl);
      pendingByAsset.set(assetId, Promise.resolve(objectUrl));
      return true;
    },
    retain() {
      if (disposed) {
        throw new Error("Room Document Asset resolver is disposed.");
      }
      activeRetainers += 1;
      disposalGeneration += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        activeRetainers -= 1;
        if (activeRetainers !== 0) {
          return;
        }
        const scheduledGeneration = ++disposalGeneration;
        queueMicrotask(() => {
          if (
            activeRetainers !== 0 ||
            disposalGeneration !== scheduledGeneration
          ) {
            return;
          }
          disposed = true;
          for (const objectUrl of objectUrls) {
            URL.revokeObjectURL(objectUrl);
          }
          objectUrls.clear();
          pendingByAsset.clear();
        });
      };
    },
    async resolve(reference) {
      if (reference === "") {
        return "";
      }
      const assetId = parseRoomDocumentAssetReference(reference);
      if (assetId === undefined) {
        throw new Error("Room Document Asset reference is invalid.");
      }
      if (disposed) {
        throw new Error("Room Document Asset resolver is disposed.");
      }
      let pending = pendingByAsset.get(assetId);
      if (pending === undefined) {
        pending = (async () => {
          const metadata = await teamHubData(
            client.api.GET("/v0/document-assets/{documentAssetId}", {
              params: { path: { documentAssetId: assetId } },
            }),
          );
          if (
            metadata.id !== assetId ||
            metadata.status !== "available" ||
            metadata.size_bytes < 1 ||
            metadata.size_bytes > maxRoomDocumentAssetBytes ||
            metadata.size_bytes > maxResidentBytes - residentBytes
          ) {
            throw new Error(
              "Room Document Asset exceeds the browser resident budget.",
            );
          }
          residentBytes += metadata.size_bytes;
          try {
            const content = await downloadGate.run(() =>
              teamHubData(
                client.api.GET(
                  "/v0/document-assets/{documentAssetId}/content",
                  {
                    params: { path: { documentAssetId: assetId } },
                    parseAs: "blob",
                  },
                ),
              ),
            );
            if (content.size !== metadata.size_bytes) {
              throw new Error(
                "TeamHub returned inconsistent Document Asset content.",
              );
            }
            // Resolver disposal owns this URL; the rule cannot follow closure state across methods.
            // oxlint-disable-next-line react-doctor/no-create-object-url-without-revoke
            const objectUrl = URL.createObjectURL(
              browserSafeAssetBlob(content),
            );
            if (disposed) {
              URL.revokeObjectURL(objectUrl);
              throw new Error("Room Document Asset resolver is disposed.");
            }
            objectUrls.add(objectUrl);
            return objectUrl;
          } catch (error) {
            residentBytes -= metadata.size_bytes;
            throw error;
          }
        })().catch((error: unknown) => {
          pendingByAsset.delete(assetId);
          throw error;
        });
        pendingByAsset.set(assetId, pending);
      }
      return await pending;
    },
  };
}

class AsyncGate {
  readonly #waiters: Array<() => void> = [];
  #active = 0;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Async gate limit must be a positive integer.");
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await operation();
    } finally {
      const next = this.#waiters.shift();
      if (next === undefined) {
        this.#active -= 1;
      } else {
        next();
      }
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.limit) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }
}

const roomDocumentAssetUploadGate = new AsyncGate(2);

function browserSafeAssetBlob(content: Blob): Blob {
  const mediaType = content.type.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== undefined &&
    browserRenderableAssetMediaTypes.has(mediaType)
  ) {
    return content;
  }
  return new Blob([content], { type: "application/octet-stream" });
}

function hashDocumentAsset(file: File) {
  if (typeof Worker === "undefined") {
    return hashBlobIncrementally(file).catch((error: unknown) => {
      throw documentAssetHashError("hash", error);
    });
  }
  return new Promise<{ bytesRead: number; sha256: string }>(
    (resolve, reject) => {
      const worker = new Worker(documentAssetHashWorkerUrl, { type: "module" });
      const requestId =
        globalThis.crypto?.randomUUID?.() ?? `document-asset-${Date.now()}`;
      const dispose = () => {
        globalThis.clearTimeout(timeout);
        worker.terminate();
      };
      const timeout = globalThis.setTimeout(() => {
        dispose();
        reject(
          new DocumentAssetUploadError(
            "hash",
            "Document Asset hashing timed out.",
          ),
        );
      }, documentAssetHashTimeoutMs);
      worker.addEventListener(
        "message",
        (event: MessageEvent<DocumentAssetHashResponse>) => {
          if (event.data.requestId !== requestId) return;
          dispose();
          if (event.data.kind === "failed") {
            reject(
              new DocumentAssetUploadError(
                event.data.stage,
                `Document Asset ${event.data.stage} failed: ${event.data.message}`,
              ),
            );
          } else {
            resolve(event.data);
          }
        },
      );
      worker.addEventListener("error", (event) => {
        dispose();
        reject(
          new DocumentAssetUploadError(
            "hash",
            `Document Asset hashing failed: ${event.message || "Worker execution failed."}`,
          ),
        );
      });
      worker.postMessage({
        file,
        requestId,
      } satisfies DocumentAssetHashRequest);
    },
  );
}

async function sha256SmallValue(bytes: Uint8Array): Promise<string> {
  if (globalThis.isSecureContext && globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      Uint8Array.from(bytes).buffer,
    );
    return bytesToHex(new Uint8Array(digest));
  }
  return bytesToHex(sha256(bytes));
}

async function runDocumentAssetStage<T>(
  stage: Extract<DocumentAssetUploadStage, "content-upload" | "plan">,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const label = stage === "plan" ? "planning" : "content upload";
    throw new DocumentAssetUploadError(
      stage,
      `Document Asset ${label} failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function documentAssetHashError(
  stage: Extract<DocumentAssetUploadStage, "hash" | "read">,
  error: unknown,
) {
  if (error instanceof DocumentAssetUploadError) return error;
  return new DocumentAssetUploadError(
    stage,
    `Document Asset ${stage} failed: ${errorMessage(error)}`,
    { cause: error },
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}
